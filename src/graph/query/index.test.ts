import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GraphStoreAdapter } from "../store/adapter.js";
import { insertEdge, insertNode } from "../store/queries.js";
import type { GraphEdge, GraphNode, GraphSymbol } from "../store/types.js";
import {
  configureGraphQuery,
  getCallees,
  getCallers,
  getGraphStats,
  getImpactedFiles,
  lookupSymbol,
} from "./index.js";
import { GRAPH_QUERY_RESPONSE_VERSION } from "./types.js";

describe("graph query API", () => {
  it("looks up symbols and returns null for unknown names", () => {
    const adapter = createAdapter();
    adapter.open();
    const db = adapter.getDatabase();

    seedFile(db, "file-a", "/repo/src/a.ts");
    seedSymbol(db, {
      symbolId: "symbol-alpha",
      nodeId: "node-alpha",
      fileId: "file-a",
      name: "alpha",
      kind: "function",
      signature: "function alpha() {}",
      exported: true,
      nodeType: "FUNCTION",
    });
    seedFileNode(db, "file-a", "/repo/src/a.ts");

    configureGraphQuery({ graphStore: adapter });
    try {
      expect(lookupSymbol("missing")).toBeNull();
      expect(lookupSymbol("alpha", "/repo/src/not-a.ts")).toBeNull();
      expect(lookupSymbol("alpha")).toEqual({
        version: GRAPH_QUERY_RESPONSE_VERSION,
        id: "symbol-alpha",
        name: "alpha",
        kind: "function",
        signature: "function alpha() {}",
        exported: true,
        filePath: "/repo/src/a.ts",
      });
    } finally {
      configureGraphQuery({ graphStore: null });
      adapter.close();
    }
  });

  it("returns callers and callees by symbol id", () => {
    const adapter = createAdapter();
    adapter.open();
    const db = adapter.getDatabase();

    seedFile(db, "file-a", "/repo/src/a.ts");
    seedFile(db, "file-b", "/repo/src/b.ts");
    seedFile(db, "file-c", "/repo/src/c.ts");

    seedSymbol(db, {
      symbolId: "symbol-alpha",
      nodeId: "node-alpha",
      fileId: "file-a",
      name: "alpha",
      kind: "function",
      signature: "function alpha() { beta(); gamma(); }",
      exported: true,
      nodeType: "FUNCTION",
    });
    seedSymbol(db, {
      symbolId: "symbol-beta",
      nodeId: "node-beta",
      fileId: "file-b",
      name: "beta",
      kind: "function",
      signature: "function beta() {}",
      exported: true,
      nodeType: "FUNCTION",
    });
    seedSymbol(db, {
      symbolId: "symbol-gamma",
      nodeId: "node-gamma",
      fileId: "file-c",
      name: "gamma",
      kind: "function",
      signature: "function gamma() {}",
      exported: false,
      nodeType: "FUNCTION",
    });

    seedEdge(db, {
      id: "edge-calls-alpha-beta",
      type: "CALLS",
      fromNodeId: "node-alpha",
      toNodeId: "node-beta",
    });
    seedEdge(db, {
      id: "edge-calls-alpha-gamma",
      type: "CALLS",
      fromNodeId: "node-alpha",
      toNodeId: "node-gamma",
    });

    configureGraphQuery({ graphStore: adapter });
    try {
      expect(getCallers("symbol-beta")).toEqual([
        {
          version: GRAPH_QUERY_RESPONSE_VERSION,
          id: "symbol-alpha",
          name: "alpha",
          kind: "function",
          signature: "function alpha() { beta(); gamma(); }",
          exported: true,
          filePath: "/repo/src/a.ts",
        },
      ]);

      expect(getCallees("symbol-alpha")).toEqual([
        {
          version: GRAPH_QUERY_RESPONSE_VERSION,
          id: "symbol-beta",
          name: "beta",
          kind: "function",
          signature: "function beta() {}",
          exported: true,
          filePath: "/repo/src/b.ts",
        },
        {
          version: GRAPH_QUERY_RESPONSE_VERSION,
          id: "symbol-gamma",
          name: "gamma",
          kind: "function",
          signature: "function gamma() {}",
          exported: false,
          filePath: "/repo/src/c.ts",
        },
      ]);
    } finally {
      configureGraphQuery({ graphStore: null });
      adapter.close();
    }
  });

  it("walks transitively across CALLS and IMPORTS with cycle-safe depth bounds", () => {
    const adapter = createAdapter();
    adapter.open();
    const db = adapter.getDatabase();

    seedFile(db, "file-a", "/repo/src/a.ts");
    seedFile(db, "file-b", "/repo/src/b.ts");
    seedFile(db, "file-c", "/repo/src/c.ts");
    seedFile(db, "file-d", "/repo/src/d.ts");
    seedFile(db, "file-e", "/repo/src/e.ts");
    seedFile(db, "file-f", "/repo/src/f.ts");
    seedFile(db, "file-g", "/repo/src/g.ts");
    seedFile(db, "file-h", "/repo/src/h.ts");
    seedFile(db, "file-i", "/repo/src/i.ts");
    seedFile(db, "file-j", "/repo/src/j.ts");
    seedFile(db, "file-k", "/repo/src/k.ts");
    seedFile(db, "file-l", "/repo/src/l.ts");

    for (const fileId of [
      "file-a",
      "file-b",
      "file-c",
      "file-d",
      "file-e",
      "file-f",
      "file-g",
      "file-h",
      "file-i",
      "file-j",
      "file-k",
      "file-l",
    ]) {
      seedFileNode(db, fileId, `/repo/src/${fileId.slice(-1)}.ts`);
    }

    seedSymbol(db, {
      symbolId: "symbol-alpha",
      nodeId: "node-alpha",
      fileId: "file-a",
      name: "alpha",
      kind: "function",
      signature: "function alpha() { beta(); }",
      exported: true,
      nodeType: "FUNCTION",
    });
    seedSymbol(db, {
      symbolId: "symbol-beta",
      nodeId: "node-beta",
      fileId: "file-b",
      name: "beta",
      kind: "function",
      signature: "function beta() { gamma(); }",
      exported: true,
      nodeType: "FUNCTION",
    });
    seedSymbol(db, {
      symbolId: "symbol-gamma",
      nodeId: "node-gamma",
      fileId: "file-c",
      name: "gamma",
      kind: "function",
      signature: "function gamma() {}",
      exported: true,
      nodeType: "FUNCTION",
    });

    seedDefinedIn(db, "node-alpha", "file-a");
    seedDefinedIn(db, "node-beta", "file-b");
    seedDefinedIn(db, "node-gamma", "file-c");

    seedEdge(db, {
      id: "edge-calls-alpha-beta",
      type: "CALLS",
      fromNodeId: "node-alpha",
      toNodeId: "node-beta",
    });
    seedEdge(db, {
      id: "edge-calls-beta-gamma",
      type: "CALLS",
      fromNodeId: "node-beta",
      toNodeId: "node-gamma",
    });

    seedImports(db, "file-a", "file-b");
    seedImports(db, "file-b", "file-c");
    seedImports(db, "file-c", "file-a");
    seedImports(db, "file-c", "file-d");
    seedImports(db, "file-d", "file-e");
    seedImports(db, "file-e", "file-f");
    seedImports(db, "file-f", "file-g");
    seedImports(db, "file-g", "file-h");
    seedImports(db, "file-h", "file-i");
    seedImports(db, "file-i", "file-j");
    seedImports(db, "file-j", "file-k");
    seedImports(db, "file-k", "file-l");

    configureGraphQuery({ graphStore: adapter });
    try {
      const impacted = getImpactedFiles("symbol-alpha").map((file) => file.path);
      expect(impacted).toEqual([
        "/repo/src/a.ts",
        "/repo/src/b.ts",
        "/repo/src/c.ts",
        "/repo/src/d.ts",
        "/repo/src/e.ts",
        "/repo/src/f.ts",
        "/repo/src/g.ts",
        "/repo/src/h.ts",
        "/repo/src/i.ts",
      ]);
      expect(impacted).not.toContain("/repo/src/j.ts");
      expect(impacted).not.toContain("/repo/src/l.ts");
    } finally {
      configureGraphQuery({ graphStore: null });
      adapter.close();
    }
  });

  it("returns graph stats", () => {
    const adapter = createAdapter();
    adapter.open();
    const db = adapter.getDatabase();

    seedFile(db, "file-a", "/repo/src/a.ts");
    seedFileNode(db, "file-a", "/repo/src/a.ts");
    seedSymbol(db, {
      symbolId: "symbol-alpha",
      nodeId: "node-alpha",
      fileId: "file-a",
      name: "alpha",
      kind: "function",
      signature: "function alpha() {}",
      exported: true,
      nodeType: "FUNCTION",
    });
    seedDefinedIn(db, "node-alpha", "file-a");

    configureGraphQuery({ graphStore: adapter });
    try {
      expect(getGraphStats()).toEqual({
        version: GRAPH_QUERY_RESPONSE_VERSION,
        nodeCount: 2,
        edgeCount: 1,
        fileCount: 1,
        symbolCount: 1,
      });
    } finally {
      configureGraphQuery({ graphStore: null });
      adapter.close();
    }
  });
});

function createAdapter(): GraphStoreAdapter {
  const root = mkdtempSync(join(tmpdir(), "polaris-graph-query-"));
  return new GraphStoreAdapter({
    dbPath: join(".polaris", "graph", "graph.sqlite"),
    graphOutputPath: ".polaris/graph",
    repoRoot: root,
  });
}

function seedFile(db: ReturnType<GraphStoreAdapter["getDatabase"]>, id: string, path: string): void {
  db.prepare("INSERT INTO files (id, path, language) VALUES (?1, ?2, ?3)").run(id, path, "ts");
}

interface SeedSymbolInput {
  symbolId: string;
  nodeId: string;
  fileId: string;
  name: string;
  kind: GraphSymbol["kind"];
  signature: string | null;
  exported: boolean;
  nodeType: GraphNode["type"];
}

function seedSymbol(db: ReturnType<GraphStoreAdapter["getDatabase"]>, symbol: SeedSymbolInput): void {
  insertNode(db, {
    id: symbol.nodeId,
    type: symbol.nodeType,
    fileId: symbol.fileId,
    name: symbol.name,
  });

  db.prepare(
    `
      INSERT INTO symbols (id, node_id, file_id, name, kind, signature, exported)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `,
  ).run(
    symbol.symbolId,
    symbol.nodeId,
    symbol.fileId,
    symbol.name,
    symbol.kind,
    symbol.signature,
    symbol.exported ? 1 : 0,
  );
}

function seedFileNode(db: ReturnType<GraphStoreAdapter["getDatabase"]>, fileId: string, filePath: string): void {
  insertNode(db, {
    id: `node-file-${fileId}`,
    type: "FILE",
    fileId,
    name: filePath,
  });
}

function seedDefinedIn(db: ReturnType<GraphStoreAdapter["getDatabase"]>, symbolNodeId: string, fileId: string): void {
  seedEdge(db, {
    id: `edge-defined-in-${symbolNodeId}-${fileId}`,
    type: "DEFINED_IN",
    fromNodeId: symbolNodeId,
    toNodeId: `node-file-${fileId}`,
  });
}

function seedImports(db: ReturnType<GraphStoreAdapter["getDatabase"]>, fromFileId: string, toFileId: string): void {
  seedEdge(db, {
    id: `edge-imports-${fromFileId}-${toFileId}`,
    type: "IMPORTS",
    fromNodeId: `node-file-${fromFileId}`,
    toNodeId: `node-file-${toFileId}`,
  });
}

function seedEdge(db: ReturnType<GraphStoreAdapter["getDatabase"]>, edge: GraphEdge): void {
  insertEdge(db, edge);
}
