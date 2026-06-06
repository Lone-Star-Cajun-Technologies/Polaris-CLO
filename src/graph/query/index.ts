import type { DatabaseSync } from "node:sqlite";
import { GraphStoreAdapter } from "../store/adapter.js";
import { DEFAULT_IMPACT_MAX_DEPTH, GRAPH_QUERY_RESPONSE_VERSION, type GraphFile, type GraphStats, type GraphSymbol } from "./types.js";

const FILE_NODE_PREFIX = "node-file-";

interface SymbolRow {
  id: string;
  nodeId: string;
  name: string;
  kind: GraphSymbol["kind"];
  signature: string | null;
  exported: number;
  fileId: string;
  filePath: string;
}

interface FileRow {
  fileId: string;
  path: string;
  language: string;
}

interface CountRow {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  symbolCount: number;
}

interface QueryState {
  defaultStore: GraphStoreAdapter | null;
  overrideStore: GraphStoreAdapter | null;
}

const queryState: QueryState = {
  defaultStore: null,
  overrideStore: null,
};

export interface GraphQueryOptions {
  graphStore?: GraphStoreAdapter | null;
}

export function configureGraphQuery(options: GraphQueryOptions): void {
  queryState.overrideStore = options.graphStore ?? null;
}

export function lookupSymbol(name: string, file?: string): GraphSymbol | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          s.id,
          s.node_id AS nodeId,
          s.name,
          s.kind,
          s.signature,
          s.exported,
          s.file_id AS fileId,
          f.path AS filePath
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE s.name = ?1
          AND (?2 IS NULL OR f.path = ?2)
        ORDER BY s.id
        LIMIT 1
      `,
    )
    .get(name, file ?? null) as SymbolRow | undefined;

  if (!row) {
    return null;
  }

  return toGraphSymbol(row);
}

export function getCallers(symbolId: string): GraphSymbol[] {
  const db = getDatabase();
  return lookupRelatedSymbols(db, symbolId, "CALLS", "to_node_id", "from_node_id");
}

export function getCallees(symbolId: string): GraphSymbol[] {
  const db = getDatabase();
  return lookupRelatedSymbols(db, symbolId, "CALLS", "from_node_id", "to_node_id");
}

export function getImpactedFiles(symbolId: string): GraphFile[] {
  const db = getDatabase();
  const root = lookupSymbolRowById(db, symbolId);
  if (!root) {
    return [];
  }

  const impactedFiles = new Map<string, GraphFile>();
  const visitedSymbolNodes = new Set<string>();
  const visitedFileNodes = new Set<string>();
  const queue: Array<{ kind: "symbol" | "file"; nodeId: string; depth: number }> = [];

  addImpactedFile(impactedFiles, {
    fileId: root.fileId,
    path: root.filePath,
    language: lookupLanguageByFileId(db, root.fileId),
  });

  queue.push({ kind: "symbol", nodeId: root.nodeId, depth: 0 });

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    if (current.depth > DEFAULT_IMPACT_MAX_DEPTH) {
      continue;
    }

    if (current.kind === "symbol") {
      if (visitedSymbolNodes.has(current.nodeId)) {
        continue;
      }
      visitedSymbolNodes.add(current.nodeId);

      const symbolFile = lookupFileBySymbolNodeId(db, current.nodeId);
      if (symbolFile) {
        addImpactedFile(impactedFiles, symbolFile);
        queue.push({
          kind: "file",
          nodeId: `${FILE_NODE_PREFIX}${symbolFile.fileId}`,
          depth: current.depth + 1,
        });
      }

      const outgoingCalls = db
        .prepare(
          `
            SELECT e.to_node_id AS nodeId
            FROM edges e
            WHERE e.type = 'CALLS'
              AND e.from_node_id = ?1
            ORDER BY e.to_node_id
          `,
        )
        .all(current.nodeId) as Array<{ nodeId: string }>;

      for (const edge of outgoingCalls) {
        queue.push({ kind: "symbol", nodeId: edge.nodeId, depth: current.depth + 1 });
      }
      continue;
    }

    if (visitedFileNodes.has(current.nodeId)) {
      continue;
    }
    visitedFileNodes.add(current.nodeId);

    const fileByNode = lookupFileByFileNodeId(db, current.nodeId);
    if (fileByNode) {
      addImpactedFile(impactedFiles, fileByNode);
    }

    const importedFiles = db
      .prepare(
        `
          SELECT e.to_node_id AS fileNodeId
          FROM edges e
          WHERE e.type = 'IMPORTS'
            AND e.from_node_id = ?1
          ORDER BY e.to_node_id
        `,
      )
      .all(current.nodeId) as Array<{ fileNodeId: string }>;

    for (const imported of importedFiles) {
      const importedFile = lookupFileByFileNodeId(db, imported.fileNodeId);
      if (importedFile) {
        addImpactedFile(impactedFiles, importedFile);
      }
      queue.push({ kind: "file", nodeId: imported.fileNodeId, depth: current.depth + 1 });
    }

    const symbolsInFile = db
      .prepare(
        `
          SELECT e.from_node_id AS symbolNodeId
          FROM edges e
          WHERE e.type = 'DEFINED_IN'
            AND e.to_node_id = ?1
          ORDER BY e.from_node_id
        `,
      )
      .all(current.nodeId) as Array<{ symbolNodeId: string }>;

    for (const symbol of symbolsInFile) {
      queue.push({ kind: "symbol", nodeId: symbol.symbolNodeId, depth: current.depth + 1 });
    }
  }

  return Array.from(impactedFiles.values()).sort((left, right) => left.path.localeCompare(right.path));
}

export function getGraphStats(): GraphStats {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM nodes) AS nodeCount,
          (SELECT COUNT(*) FROM edges) AS edgeCount,
          (SELECT COUNT(*) FROM files) AS fileCount,
          (SELECT COUNT(*) FROM symbols) AS symbolCount
      `,
    )
    .get() as unknown as CountRow;

  return {
    version: GRAPH_QUERY_RESPONSE_VERSION,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    fileCount: row.fileCount,
    symbolCount: row.symbolCount,
  };
}

function getDatabase(): DatabaseSync {
  const activeStore = queryState.overrideStore ?? getDefaultStore();
  return activeStore.getDatabase();
}

function getDefaultStore(): GraphStoreAdapter {
  if (queryState.defaultStore) {
    return queryState.defaultStore;
  }

  const store = new GraphStoreAdapter({
    dbPath: ".polaris/graph/graph.sqlite",
    graphOutputPath: ".polaris/graph",
  });
  store.open();
  queryState.defaultStore = store;
  return store;
}

function lookupRelatedSymbols(
  db: DatabaseSync,
  symbolId: string,
  edgeType: "CALLS",
  sourceColumn: "from_node_id" | "to_node_id",
  targetColumn: "from_node_id" | "to_node_id",
): GraphSymbol[] {
  const source = lookupSymbolRowById(db, symbolId);
  if (!source) {
    return [];
  }

  const rows = db
    .prepare(
      `
        SELECT DISTINCT
          s.id,
          s.node_id AS nodeId,
          s.name,
          s.kind,
          s.signature,
          s.exported,
          s.file_id AS fileId,
          f.path AS filePath
        FROM edges e
        JOIN symbols s ON s.node_id = e.${targetColumn}
        JOIN files f ON f.id = s.file_id
        WHERE e.type = ?1
          AND e.${sourceColumn} = ?2
        ORDER BY s.id
      `,
    )
    .all(edgeType, source.nodeId) as unknown as SymbolRow[];

  return rows.map((row) => toGraphSymbol(row));
}

function lookupSymbolRowById(db: DatabaseSync, symbolId: string): SymbolRow | null {
  const row = db
    .prepare(
      `
        SELECT
          s.id,
          s.node_id AS nodeId,
          s.name,
          s.kind,
          s.signature,
          s.exported,
          s.file_id AS fileId,
          f.path AS filePath
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE s.id = ?1
        LIMIT 1
      `,
    )
    .get(symbolId) as SymbolRow | undefined;

  return row ?? null;
}

function lookupFileBySymbolNodeId(db: DatabaseSync, symbolNodeId: string): FileRow | null {
  const row = db
    .prepare(
      `
        SELECT DISTINCT
          f.id AS fileId,
          f.path,
          f.language
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE s.node_id = ?1
        LIMIT 1
      `,
    )
    .get(symbolNodeId) as FileRow | undefined;

  return row ?? null;
}

function lookupFileByFileNodeId(db: DatabaseSync, fileNodeId: string): FileRow | null {
  const row = db
    .prepare(
      `
        SELECT
          f.id AS fileId,
          f.path,
          f.language
        FROM nodes n
        JOIN files f ON f.id = n.file_id
        WHERE n.id = ?1
          AND n.type = 'FILE'
        LIMIT 1
      `,
    )
    .get(fileNodeId) as FileRow | undefined;

  return row ?? null;
}

function lookupLanguageByFileId(db: DatabaseSync, fileId: string): string {
  const row = db
    .prepare(
      `
        SELECT language
        FROM files
        WHERE id = ?1
        LIMIT 1
      `,
    )
    .get(fileId) as { language: string } | undefined;
  return row?.language ?? "unknown";
}

function addImpactedFile(target: Map<string, GraphFile>, file: FileRow): void {
  target.set(file.path, {
    version: GRAPH_QUERY_RESPONSE_VERSION,
    path: file.path,
    language: file.language,
  });
}

function toGraphSymbol(row: SymbolRow): GraphSymbol {
  return {
    version: GRAPH_QUERY_RESPONSE_VERSION,
    id: row.id,
    name: row.name,
    kind: row.kind,
    signature: row.signature,
    exported: row.exported === 1,
    filePath: row.filePath,
  };
}
