import { createHash } from "node:crypto";
import { dirname, extname, normalize, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertNode } from "../store/queries.js";
import type { GraphNode, GraphSymbol } from "../store/types.js";

const UNRESOLVED_FILE_PREFIX = "file-unresolved-";
const UNRESOLVED_NODE_PREFIX = "node-unresolved-";
const UNRESOLVED_SYMBOL_PREFIX = "symbol-unresolved-";
const UNRESOLVED_PATH_PREFIX = "unresolved://";
const UNRESOLVED_SIGNATURE = "__UNRESOLVED__";

interface FileRow {
  id: string;
  path: string;
}

interface ImportRow {
  symbolId: string;
  importerFileId: string;
  importerFilePath: string;
  specifier: string;
}

interface SymbolRow {
  id: string;
  fileId: string;
  name: string;
  exported: number;
}

export interface ResolvedImport {
  importSymbolId: string;
  importSpecifier: string;
  importerFileId: string;
  importerFilePath: string;
  resolvedFileId: string;
  resolvedFilePath: string;
  resolvedSymbolIds: string[];
  unresolved: boolean;
}

export function resolveImports(db: DatabaseSync): ResolvedImport[] {
  const files = db
    .prepare(
      `
        SELECT id, path
        FROM files
      `,
    )
    .all() as unknown as FileRow[];
  const byPath = new Map<string, FileRow>();
  for (const file of files) {
    byPath.set(normalize(file.path), file);
  }

  const exportedByFileId = new Map<string, string[]>();
  const symbols = db
    .prepare(
      `
        SELECT id, file_id AS fileId, name, exported
        FROM symbols
        WHERE kind != 'import'
      `,
    )
    .all() as unknown as SymbolRow[];
  for (const symbol of symbols) {
    if (symbol.exported !== 1) {
      continue;
    }
    const existing = exportedByFileId.get(symbol.fileId) ?? [];
    existing.push(symbol.id);
    exportedByFileId.set(symbol.fileId, existing);
  }
  for (const symbolIds of exportedByFileId.values()) {
    symbolIds.sort((left, right) => left.localeCompare(right));
  }

  const imports = db
    .prepare(
      `
        SELECT
          s.id AS symbolId,
          s.file_id AS importerFileId,
          f.path AS importerFilePath,
          s.name AS specifier
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE s.kind = 'import'
        ORDER BY f.path, s.name, s.id
      `,
    )
    .all() as unknown as ImportRow[];

  const resolvedImports: ResolvedImport[] = [];
  for (const entry of imports) {
    const resolvedFile = resolveImportSpecifier(entry.importerFilePath, entry.specifier, byPath);
    if (resolvedFile) {
      const resolvedSymbolIds = exportedByFileId.get(resolvedFile.id) ?? [];
      const unresolved = resolvedSymbolIds.length === 0;
      resolvedImports.push({
        importSymbolId: entry.symbolId,
        importSpecifier: entry.specifier,
        importerFileId: entry.importerFileId,
        importerFilePath: entry.importerFilePath,
        resolvedFileId: resolvedFile.id,
        resolvedFilePath: resolvedFile.path,
        resolvedSymbolIds,
        unresolved,
      });
      continue;
    }

    const unresolvedTarget = upsertUnresolvedImportStub(db, entry);
    resolvedImports.push({
      importSymbolId: entry.symbolId,
      importSpecifier: entry.specifier,
      importerFileId: entry.importerFileId,
      importerFilePath: entry.importerFilePath,
      resolvedFileId: unresolvedTarget.file.id,
      resolvedFilePath: unresolvedTarget.file.path,
      resolvedSymbolIds: [unresolvedTarget.symbol.id],
      unresolved: true,
    });
  }

  return resolvedImports;
}

export function clearResolverStubs(db: DatabaseSync): void {
  db.prepare("DELETE FROM edges WHERE type IN ('CALLS', 'IMPORTS', 'DEFINED_IN')").run();
  db.prepare("DELETE FROM symbols WHERE id LIKE ?1").run(`${UNRESOLVED_SYMBOL_PREFIX}%`);
  db.prepare("DELETE FROM nodes WHERE id LIKE ?1").run(`${UNRESOLVED_NODE_PREFIX}%`);
  db.prepare("DELETE FROM files WHERE id LIKE ?1 OR path LIKE ?2").run(
    `${UNRESOLVED_FILE_PREFIX}%`,
    `${UNRESOLVED_PATH_PREFIX}%`,
  );
}

interface UnresolvedImportStub {
  file: FileRow;
  symbol: GraphSymbol;
}

function upsertUnresolvedImportStub(db: DatabaseSync, row: ImportRow): UnresolvedImportStub {
  const digest = makeDigest(`${row.importerFilePath}:${row.specifier}`);
  const fileId = `${UNRESOLVED_FILE_PREFIX}${digest}`;
  const filePath = `${UNRESOLVED_PATH_PREFIX}${row.importerFilePath}::${row.specifier}`;
  const nodeId = `${UNRESOLVED_NODE_PREFIX}${digest}`;
  const symbolId = `${UNRESOLVED_SYMBOL_PREFIX}${digest}`;

  db.prepare(
    `
      INSERT INTO files (id, path, language)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        language = excluded.language
    `,
  ).run(fileId, filePath, "unknown");

  const node: GraphNode = {
    id: nodeId,
    type: "IMPORT",
    fileId,
    name: `UNRESOLVED:${row.specifier}`,
  };
  insertNode(db, node);

  db.prepare(
    `
      INSERT INTO symbols (id, node_id, file_id, name, kind, signature, exported)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
      ON CONFLICT(id) DO UPDATE SET
        node_id = excluded.node_id,
        file_id = excluded.file_id,
        name = excluded.name,
        kind = excluded.kind,
        signature = excluded.signature,
        exported = excluded.exported
    `,
  ).run(symbolId, nodeId, fileId, row.specifier, "unknown", UNRESOLVED_SIGNATURE);

  return {
    file: {
      id: fileId,
      path: filePath,
    },
    symbol: {
      id: symbolId,
      nodeId,
      fileId,
      name: row.specifier,
      kind: "unknown",
      signature: UNRESOLVED_SIGNATURE,
      exported: false,
    },
  };
}

function resolveImportSpecifier(importerPath: string, specifier: string, byPath: Map<string, FileRow>): FileRow | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const importerDir = dirname(importerPath);
  const candidates = new Set<string>();
  const base = normalize(resolve(importerDir, specifier));
  candidates.add(base);

  const ext = extname(base);
  if (!ext) {
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.add(`${base}${extension}`);
    }
    for (const extension of ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs"]) {
      candidates.add(`${base}${extension}`);
    }
  }

  for (const candidate of candidates) {
    const found = byPath.get(candidate);
    if (found) {
      return found;
    }
  }

  return null;
}

function makeDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}
