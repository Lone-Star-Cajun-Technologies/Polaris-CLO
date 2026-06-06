import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { insertEdge, insertNode } from "../store/queries.js";
import type { GraphEdge, GraphNode, GraphSymbol } from "../store/types.js";
import type { ResolvedImport } from "./resolve-imports.js";

const FILE_NODE_PREFIX = "node-file-";
const UNRESOLVED_NODE_PREFIX = "node-unresolved-call-";
const UNRESOLVED_SYMBOL_PREFIX = "symbol-unresolved-call-";
const UNRESOLVED_SIGNATURE = "__UNRESOLVED__";

interface FileRow {
  id: string;
  path: string;
}

interface SymbolWithNode {
  id: string;
  nodeId: string;
  fileId: string;
  name: string;
  kind: GraphSymbol["kind"];
  signature: string | null;
}

export interface ResolverBuildResult {
  callsEdges: number;
  importsEdges: number;
  definedInEdges: number;
  unresolvedImports: number;
  unresolvedCalls: number;
}

export function buildEdges(db: DatabaseSync, resolvedImports: readonly ResolvedImport[]): ResolverBuildResult {
  const files = db
    .prepare(
      `
        SELECT id, path
        FROM files
      `,
    )
    .all() as unknown as FileRow[];
  for (const file of files) {
    upsertFileNode(db, file.id, file.path);
  }

  const symbols = db
    .prepare(
      `
        SELECT id, node_id AS nodeId, file_id AS fileId, name, kind, signature
        FROM symbols
      `,
    )
    .all() as unknown as SymbolWithNode[];
  const symbolById = new Map<string, SymbolWithNode>();
  const symbolsByName = new Map<string, SymbolWithNode[]>();
  for (const symbol of symbols) {
    symbolById.set(symbol.id, symbol);
    if (symbol.kind === "import") {
      continue;
    }
    const existing = symbolsByName.get(symbol.name) ?? [];
    existing.push(symbol);
    symbolsByName.set(symbol.name, existing);
  }
  for (const list of symbolsByName.values()) {
    list.sort((left, right) => left.id.localeCompare(right.id));
  }

  let importsEdges = 0;
  let unresolvedImports = 0;
  for (const resolvedImport of resolvedImports) {
    const fromFileNodeId = toFileNodeId(resolvedImport.importerFileId);
    const targetFileNodeId = toFileNodeId(resolvedImport.resolvedFileId);
    const importEdge: GraphEdge = {
      id: makeEdgeId("imports", fromFileNodeId, targetFileNodeId, resolvedImport.importSpecifier),
      type: "IMPORTS",
      fromNodeId: fromFileNodeId,
      toNodeId: targetFileNodeId,
      metadata: JSON.stringify({
        importSpecifier: resolvedImport.importSpecifier,
        resolvedSymbolIds: resolvedImport.resolvedSymbolIds,
        UNRESOLVED: resolvedImport.unresolved,
      }),
    };
    insertEdge(db, importEdge);
    importsEdges += 1;
    if (resolvedImport.unresolved) {
      unresolvedImports += 1;
    }
  }

  let definedInEdges = 0;
  for (const symbol of symbols) {
    const edge: GraphEdge = {
      id: makeEdgeId("defined-in", symbol.nodeId, toFileNodeId(symbol.fileId), symbol.id),
      type: "DEFINED_IN",
      fromNodeId: symbol.nodeId,
      toNodeId: toFileNodeId(symbol.fileId),
      metadata: null,
    };
    insertEdge(db, edge);
    definedInEdges += 1;
  }

  let callsEdges = 0;
  let unresolvedCalls = 0;
  for (const symbol of symbols) {
    if ((symbol.kind !== "function" && symbol.kind !== "method") || !symbol.signature) {
      continue;
    }

    const callees = extractCallNames(symbol.signature);
    for (const calleeName of callees) {
      if (calleeName === symbol.name) {
        continue;
      }

      const resolvedCallee = resolveCalleeSymbol(calleeName, symbol.fileId, symbolsByName);
      if (resolvedCallee) {
        const edge: GraphEdge = {
          id: makeEdgeId("calls", symbol.nodeId, resolvedCallee.nodeId, calleeName),
          type: "CALLS",
          fromNodeId: symbol.nodeId,
          toNodeId: resolvedCallee.nodeId,
          metadata: JSON.stringify({
            calleeName,
            UNRESOLVED: false,
          }),
        };
        insertEdge(db, edge);
        callsEdges += 1;
        continue;
      }

      const unresolved = upsertUnresolvedCallStub(db, symbol.fileId, calleeName);
      const unresolvedDefinedIn: GraphEdge = {
        id: makeEdgeId("defined-in", unresolved.nodeId, toFileNodeId(symbol.fileId), unresolved.nodeId),
        type: "DEFINED_IN",
        fromNodeId: unresolved.nodeId,
        toNodeId: toFileNodeId(symbol.fileId),
        metadata: JSON.stringify({
          UNRESOLVED: true,
        }),
      };
      insertEdge(db, unresolvedDefinedIn);
      definedInEdges += 1;

      const edge: GraphEdge = {
        id: makeEdgeId("calls", symbol.nodeId, unresolved.nodeId, calleeName),
        type: "CALLS",
        fromNodeId: symbol.nodeId,
        toNodeId: unresolved.nodeId,
        metadata: JSON.stringify({
          calleeName,
          UNRESOLVED: true,
        }),
      };
      insertEdge(db, edge);
      callsEdges += 1;
      unresolvedCalls += 1;
    }
  }

  return {
    callsEdges,
    importsEdges,
    definedInEdges,
    unresolvedImports,
    unresolvedCalls,
  };
}

interface UnresolvedCallStub {
  nodeId: string;
}

function upsertFileNode(db: DatabaseSync, fileId: string, filePath: string): void {
  const node: GraphNode = {
    id: toFileNodeId(fileId),
    type: "FILE",
    fileId,
    name: filePath,
  };
  insertNode(db, node);
}

function upsertUnresolvedCallStub(db: DatabaseSync, callerFileId: string, calleeName: string): UnresolvedCallStub {
  const digest = makeDigest(`${callerFileId}:${calleeName}`);
  const nodeId = `${UNRESOLVED_NODE_PREFIX}${digest}`;
  const symbolId = `${UNRESOLVED_SYMBOL_PREFIX}${digest}`;

  const node: GraphNode = {
    id: nodeId,
    type: "SYMBOL",
    fileId: callerFileId,
    name: `UNRESOLVED:${calleeName}`,
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
  ).run(symbolId, nodeId, callerFileId, calleeName, "unknown", UNRESOLVED_SIGNATURE);

  return { nodeId };
}

function resolveCalleeSymbol(
  calleeName: string,
  callerFileId: string,
  symbolsByName: Map<string, SymbolWithNode[]>,
): SymbolWithNode | null {
  const candidates = symbolsByName.get(calleeName);
  if (!candidates || candidates.length === 0) {
    return null;
  }
  const local = candidates.find((entry) => entry.fileId === callerFileId);
  return local ?? candidates[0] ?? null;
}

function extractCallNames(signature: string): string[] {
  const matches = new Set<string>();
  for (const match of signature.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = match[1];
    if (!name || RESERVED_CALL_TOKENS.has(name)) {
      continue;
    }
    matches.add(name);
  }
  return Array.from(matches.values()).sort((left, right) => left.localeCompare(right));
}

function makeEdgeId(prefix: string, fromNodeId: string, toNodeId: string, suffix: string): string {
  return `${prefix}-${makeDigest(`${fromNodeId}:${toNodeId}:${suffix}`)}`;
}

function toFileNodeId(fileId: string): string {
  return `${FILE_NODE_PREFIX}${fileId}`;
}

function makeDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

const RESERVED_CALL_TOKENS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "new",
  "typeof",
  "await",
  "import",
  "super",
  "console",
]);
