import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GraphStoreAdapter } from "./adapter.js";
import { insertEdge, insertNode, lookupFile, lookupSymbol } from "./queries.js";
import type { GraphEdge, GraphNode } from "./types.js";

describe("GraphStoreAdapter", () => {
  it("opens and initializes schema idempotently with notices output", () => {
    const root = mkdtempSync(join(tmpdir(), "polaris-graph-store-"));
    const adapter = new GraphStoreAdapter({
      dbPath: join(".polaris", "graph", "graph.sqlite"),
      graphOutputPath: ".polaris/graph",
      repoRoot: root,
    });

    adapter.open();
    adapter.initSchema();
    adapter.initSchema();

    const db = adapter.getDatabase();
    const tables = db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('schema_version', 'files', 'nodes', 'symbols', 'edges')
          ORDER BY name
        `,
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual([
      "edges",
      "files",
      "nodes",
      "schema_version",
      "symbols",
    ]);

    const versions = db.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>;
    expect(versions).toEqual([{ version: 1 }]);

    const notices = readFileSync(join(root, ".polaris", "graph", "NOTICES"), "utf-8");
    expect(notices).toContain("# NOTICES");
    expect(notices).toContain("MIT-licensed");

    adapter.close();
  });

  it("supports baseline graph store query primitives", () => {
    const root = mkdtempSync(join(tmpdir(), "polaris-graph-store-queries-"));
    const adapter = new GraphStoreAdapter({
      dbPath: join(".polaris", "graph", "graph.sqlite"),
      graphOutputPath: ".polaris/graph",
      repoRoot: root,
    });

    adapter.open();
    const db = adapter.getDatabase();

    db.prepare("INSERT INTO files (id, path, language) VALUES (?1, ?2, ?3)").run(
      "file-1",
      "src/graph/store/adapter.ts",
      "ts",
    );

    const node: GraphNode = {
      id: "node-1",
      type: "FUNCTION",
      fileId: "file-1",
      name: "open",
      startLine: 1,
      startColumn: 0,
      endLine: 10,
      endColumn: 1,
    };
    insertNode(db, node);

    db.prepare(
      `
        INSERT INTO symbols (id, node_id, file_id, name, kind, signature, exported)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `,
    ).run("symbol-1", "node-1", "file-1", "open", "function", "open(): DatabaseSync", 1);

    const edge: GraphEdge = {
      id: "edge-1",
      type: "DEFINED_IN",
      fromNodeId: "node-1",
      toNodeId: "node-1",
    };
    insertEdge(db, edge);

    expect(lookupFile(db, "src/graph/store/adapter.ts")).toEqual({
      id: "file-1",
      path: "src/graph/store/adapter.ts",
      language: "ts",
    });

    expect(lookupSymbol(db, "open")).toEqual({
      id: "symbol-1",
      nodeId: "node-1",
      fileId: "file-1",
      name: "open",
      kind: "function",
      signature: "open(): DatabaseSync",
      exported: true,
    });

    expect(lookupSymbol(db, "open", "src/graph/store/adapter.ts")?.id).toBe("symbol-1");
    expect(lookupSymbol(db, "open", "src/graph/store/queries.ts")).toBeNull();

    const edges = db.prepare("SELECT id FROM edges").all() as Array<{ id: string }>;
    expect(edges).toEqual([{ id: "edge-1" }]);

    adapter.close();
  });
});

