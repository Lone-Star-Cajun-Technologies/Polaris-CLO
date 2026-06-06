import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { AdapterRegistry, ExtractedSymbol } from "../adapter/types.js";
import { getDefaultAdapterRegistry } from "../adapter/registry.js";
import { GraphCapabilityRegistry, type GraphCapabilityReport } from "../capability/index.js";
import type { GraphStoreAdapter } from "../store/adapter.js";
import { insertNode } from "../store/queries.js";
import type { GraphNode, GraphSymbol } from "../store/types.js";

export interface ExtractionPipelineLogger {
  warn(message: string): void;
}

export interface ExtractionPipelineOptions {
  graphStore: GraphStoreAdapter;
  logger?: ExtractionPipelineLogger;
  adapterRegistry?: AdapterRegistry;
}

export interface ExtractionPipelineResult {
  processedFiles: number;
  succeededFiles: number;
  failedFiles: number;
  persistedNodes: number;
  persistedSymbols: number;
  fallbackFiles: FallbackFile[];
  warnings: string[];
  capability: GraphCapabilityReport;
}

interface FallbackFile {
  path: string;
  ext: string;
}

interface PersistableSymbol {
  node: GraphNode;
  symbol: GraphSymbol;
}

export async function runExtractionPipeline(
  filePaths: readonly string[],
  options: ExtractionPipelineOptions,
): Promise<ExtractionPipelineResult> {
  const adapterRegistry = options.adapterRegistry ?? getDefaultAdapterRegistry();
  const db = options.graphStore.getDatabase();
  const warningMessages: string[] = [];
  const sortedPaths = Array.from(new Set(filePaths)).sort((left, right) => left.localeCompare(right));
  const capabilityRegistry = new GraphCapabilityRegistry(adapterRegistry.getAll().map((adapter) => adapter.languageId));

  let succeededFiles = 0;
  let failedFiles = 0;
  let persistedNodes = 0;
  let persistedSymbols = 0;
  const fallbackFiles: FallbackFile[] = [];

  for (const filePath of sortedPaths) {
    const ext = extname(filePath).toLowerCase();
    const adapter = adapterRegistry.getForExtension(ext);
    const languageId = adapter?.languageId ?? GraphCapabilityRegistry.unsupportedLanguageId(ext);

    try {
      if (!adapter) {
        const fileId = makeDeterministicId("file", filePath);
        persistUnsupportedFile(db, filePath, languageId, fileId);
        fallbackFiles.push({ path: filePath, ext });
        succeededFiles += 1;
        persistedNodes += 1;
        const warning = `Falling back to file node for unsupported file type: ${filePath}`;
        warningMessages.push(warning);
        capabilityRegistry.noteUnsupportedExtension(ext);
        capabilityRegistry.recordFileLevel(languageId, [warning]);
        options.logger?.warn(warning);
        continue;
      }

      const source = readFileSync(filePath, "utf-8");
      const extracted = await adapter.extractSymbols(filePath, source);
      const fileId = makeDeterministicId("file", filePath);
      const symbols = extracted.symbols.map((entry, index) => toPersistableSymbol(fileId, filePath, entry, index));

      persistFileSymbols(db, filePath, extracted.language, fileId, symbols);

      succeededFiles += 1;
      persistedNodes += symbols.length;
      persistedSymbols += symbols.length;
      capabilityRegistry.recordSymbolLevel(adapter.languageId, symbols.length);
    } catch (error) {
      failedFiles += 1;
      const message = error instanceof Error ? error.message : String(error);
      const warning = `Extraction failed for ${filePath}: ${message}`;
      warningMessages.push(warning);
      if (!adapter) {
        capabilityRegistry.noteUnsupportedExtension(ext);
      }
      capabilityRegistry.recordFailure(languageId, warning);
      options.logger?.warn(warning);
    }
  }

  return {
    processedFiles: sortedPaths.length,
    succeededFiles,
    failedFiles,
    persistedNodes,
    persistedSymbols,
    fallbackFiles,
    warnings: warningMessages,
    capability: capabilityRegistry.buildReport(),
  };
}

function toPersistableSymbol(
  fileId: string,
  filePath: string,
  entry: ExtractedSymbol,
  index: number,
): PersistableSymbol {
  const symbolIdSeed = [
    filePath,
    entry.kind,
    entry.name,
    entry.startLine,
    entry.startColumn,
    entry.endLine,
    entry.endColumn,
    index,
  ].join(":");
  const symbolId = makeDeterministicId("symbol", symbolIdSeed);
  const nodeId = makeDeterministicId("node", symbolIdSeed);

  const node: GraphNode = {
    id: nodeId,
    type: mapKindToNodeType(entry.kind),
    fileId,
    name: entry.name,
    startLine: entry.startLine,
    startColumn: entry.startColumn,
    endLine: entry.endLine,
    endColumn: entry.endColumn,
  };

  const symbol: GraphSymbol = {
    id: symbolId,
    nodeId,
    fileId,
    name: entry.name,
    kind: entry.kind,
    signature: entry.signature,
    exported: entry.exported,
  };

  return { node, symbol };
}

function persistFileSymbols(
  db: ReturnType<GraphStoreAdapter["getDatabase"]>,
  filePath: string,
  language: string,
  fileId: string,
  symbols: PersistableSymbol[],
): void {
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.prepare(
      `
        INSERT INTO files (id, path, language)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(path) DO UPDATE SET
          id = excluded.id,
          language = excluded.language
      `,
    ).run(fileId, filePath, normalizeLanguage(language, filePath));

    db.prepare("DELETE FROM symbols WHERE file_id = ?1").run(fileId);
    db.prepare("DELETE FROM nodes WHERE file_id = ?1").run(fileId);

    for (const item of symbols) {
      insertNode(db, item.node);
      db.prepare(
        `
          INSERT INTO symbols (id, node_id, file_id, name, kind, signature, exported)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
          ON CONFLICT(id) DO UPDATE SET
            node_id = excluded.node_id,
            file_id = excluded.file_id,
            name = excluded.name,
            kind = excluded.kind,
            signature = excluded.signature,
            exported = excluded.exported
        `,
      ).run(
        item.symbol.id,
        item.symbol.nodeId,
        item.symbol.fileId,
        item.symbol.name,
        item.symbol.kind,
        item.symbol.signature ?? null,
        item.symbol.exported ? 1 : 0,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function persistUnsupportedFile(
  db: ReturnType<GraphStoreAdapter["getDatabase"]>,
  filePath: string,
  language: string,
  fileId: string,
): void {
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.prepare(
      `
        INSERT INTO files (id, path, language)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(path) DO UPDATE SET
          id = excluded.id,
          language = excluded.language
      `,
    ).run(fileId, filePath, normalizeLanguage(language, filePath));

    db.prepare("DELETE FROM symbols WHERE file_id = ?1").run(fileId);
    db.prepare("DELETE FROM nodes WHERE file_id = ?1").run(fileId);

    insertNode(db, {
      id: fileId,
      type: "FILE",
      fileId,
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeLanguage(language: string, filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (language === "typescript" || extension === ".ts" || extension === ".tsx") {
    return "ts";
  }
  if (
    language === "javascript" ||
    extension === ".js" ||
    extension === ".jsx" ||
    extension === ".mjs" ||
    extension === ".cjs"
  ) {
    return "js";
  }
  return language;
}

function mapKindToNodeType(kind: GraphSymbol["kind"]): GraphNode["type"] {
  switch (kind) {
    case "function":
      return "FUNCTION";
    case "class":
      return "CLASS";
    case "method":
      return "METHOD";
    case "import":
      return "IMPORT";
    default:
      return "SYMBOL";
  }
}

function makeDeterministicId(prefix: string, input: string): string {
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}
