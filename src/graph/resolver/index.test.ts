import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GraphStoreAdapter } from "../store/adapter.js";
import { insertNode } from "../store/queries.js";
import type { GraphNode } from "../store/types.js";
import { runGraphResolver } from "./index.js";

describe("runGraphResolver", () => {
  it("resolves imports, creates graph edges, and records unresolved stubs", () => {
    const adapter = createAdapter();
    adapter.open();
    const db = adapter.getDatabase();

    seedFile(db, "file-a", "/repo/src/a.ts");
    seedFile(db, "file-b", "/repo/src/b.ts");
    seedFile(db, "file-c", "/repo/src/c.ts");

    seedSymbol(db, {
      symbolId: "symbol-import-b",
      nodeId: "node-import-b",
      fileId: "file-a",
      name: "./b",
      kind: "import",
      signature: null,
      exported: false,
      nodeType: "IMPORT",
    });
    seedSymbol(db, {
      symbolId: "symbol-import-missing",
      nodeId: "node-import-missing",
      fileId: "file-a",
      name: "./missing",
      kind: "import",
      signature: null,
      exported: false,
      nodeType: "IMPORT",
    });
    seedSymbol(db, {
      symbolId: "symbol-alpha",
      nodeId: "node-alpha",
      fileId: "file-a",
      name: "alpha",
      kind: "function",
      signature: "function alpha() { beta(); missingCall(); }",
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

    const result = runGraphResolver({ graphStore: adapter });

    expect(result.resolvedImports).toBe(2);
    expect(result.importsEdges).toBe(2);
    expect(result.callsEdges).toBe(2);
    expect(result.unresolvedImports).toBe(1);
    expect(result.unresolvedCalls).toBe(1);

    const imports = db
      .prepare("SELECT metadata FROM edges WHERE type = 'IMPORTS' ORDER BY id")
      .all() as Array<{ metadata: string }>;
    expect(imports.map((row) => JSON.parse(row.metadata).UNRESOLVED)).toEqual([false, true]);
    expect(imports.map((row) => JSON.parse(row.metadata).resolvedSymbolIds.length)).toEqual([1, 1]);

    const calls = db
      .prepare("SELECT metadata FROM edges WHERE type = 'CALLS' ORDER BY id")
      .all() as Array<{ metadata: string }>;
    const unresolvedCallFlags = calls.map((row) => JSON.parse(row.metadata).UNRESOLVED as boolean);
    expect(unresolvedCallFlags.filter(Boolean)).toHaveLength(1);
    expect(unresolvedCallFlags.filter((flag) => !flag)).toHaveLength(1);

    const unresolvedSymbols = db
      .prepare(
        `
          SELECT id, name, signature
          FROM symbols
          WHERE id LIKE 'symbol-unresolved-%' OR id LIKE 'symbol-unresolved-call-%'
          ORDER BY id
        `,
      )
      .all() as Array<{ id: string; name: string; signature: string }>;
    expect(unresolvedSymbols).toHaveLength(2);
    expect(unresolvedSymbols.map((row) => row.signature)).toEqual(["__UNRESOLVED__", "__UNRESOLVED__"]);

    const definedInCount = db.prepare("SELECT COUNT(*) AS count FROM edges WHERE type = 'DEFINED_IN'").get() as {
      count: number;
    };
    expect(definedInCount.count).toBe(result.definedInEdges);

    adapter.close();
  });

  it("rebuilds edges idempotently without duplication", () => {
    const adapter = createAdapter();
    adapter.open();
    const db = adapter.getDatabase();

    seedFile(db, "file-main", "/repo/src/main.ts");
    seedFile(db, "file-lib", "/repo/src/lib.ts");

    seedSymbol(db, {
      symbolId: "symbol-import-lib",
      nodeId: "node-import-lib",
      fileId: "file-main",
      name: "./lib",
      kind: "import",
      signature: null,
      exported: false,
      nodeType: "IMPORT",
    });
    seedSymbol(db, {
      symbolId: "symbol-main",
      nodeId: "node-main",
      fileId: "file-main",
      name: "main",
      kind: "function",
      signature: "function main() { helper(); }",
      exported: true,
      nodeType: "FUNCTION",
    });
    seedSymbol(db, {
      symbolId: "symbol-helper",
      nodeId: "node-helper",
      fileId: "file-lib",
      name: "helper",
      kind: "function",
      signature: "function helper() {}",
      exported: true,
      nodeType: "FUNCTION",
    });

    const first = runGraphResolver({ graphStore: adapter });
    const second = runGraphResolver({ graphStore: adapter });

    expect(second).toEqual(first);

    const edgeCounts = db
      .prepare(
        `
          SELECT type, COUNT(*) AS count
          FROM edges
          GROUP BY type
          ORDER BY type
        `,
      )
      .all() as Array<{ type: string; count: number }>;
    expect(edgeCounts).toEqual([
      { type: "CALLS", count: 1 },
      { type: "DEFINED_IN", count: first.definedInEdges },
      { type: "IMPORTS", count: 1 },
    ]);

    adapter.close();
  });
});

function createAdapter(): GraphStoreAdapter {
  const root = mkdtempSync(join(tmpdir(), "polaris-graph-resolver-"));
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
  kind: "function" | "class" | "method" | "import" | "unknown";
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
