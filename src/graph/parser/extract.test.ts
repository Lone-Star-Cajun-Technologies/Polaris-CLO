import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphStoreAdapter } from "../store/adapter.js";
import { extractSymbolsFromTree } from "./extract.js";
import type { ParseTreeLike, SyntaxNodeLike } from "./loader.js";
import { loadTreeSitterRuntime } from "./loader.js";
import { runExtractionPipeline } from "./pipeline.js";

vi.mock("./loader.js", async () => {
  const actual = await vi.importActual<typeof import("./loader.js")>("./loader.js");
  return {
    ...actual,
    loadTreeSitterRuntime: vi.fn(),
  };
});

const mockedLoadTreeSitterRuntime = vi.mocked(loadTreeSitterRuntime);

describe("extractSymbolsFromTree", () => {
  it("extracts function, class, method, and import declarations deterministically", () => {
    const functionName = createNode("identifier", "buildGraph", 0, 9, 0, 19);
    const functionNode = createNode("function_declaration", "export function buildGraph() {}", 0, 0, 0, 30, [
      functionName,
    ]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);
    const functionExport = createNode("export_statement", "export function buildGraph() {}", 0, 0, 0, 30, [functionNode]);

    const className = createNode("identifier", "Indexer", 1, 6, 1, 13);
    const classNode = createNode("class_declaration", "class Indexer {}", 1, 0, 1, 15, [className]);
    classNode.childForFieldName = (fieldName) => (fieldName === "name" ? className : null);

    const methodName = createNode("property_identifier", "run", 2, 2, 2, 5);
    const methodNode = createNode("method_definition", "run() {}", 2, 2, 2, 10, [methodName]);
    methodNode.childForFieldName = (fieldName) => (fieldName === "name" ? methodName : null);

    const importSource = createNode("string", "\"./worker\"", 3, 17, 3, 27);
    const importNode = createNode(
      "import_statement",
      "import { run } from \"./worker\"",
      3,
      0,
      3,
      27,
      [importSource],
    );
    importNode.childForFieldName = (fieldName) => (fieldName === "source" ? importSource : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("program", "", 0, 0, 4, 0, [functionExport, classNode, methodNode, importNode]),
    };

    const extractedA = extractSymbolsFromTree(tree, "typescript");
    const extractedB = extractSymbolsFromTree(tree, "typescript");

    expect(extractedA).toEqual(extractedB);
    expect(extractedA.symbols).toEqual([
      {
        kind: "function",
        name: "buildGraph",
        signature: "export function buildGraph() {}",
        exported: true,
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 30,
      },
      {
        kind: "class",
        name: "Indexer",
        signature: null,
        exported: false,
        startLine: 2,
        startColumn: 0,
        endLine: 2,
        endColumn: 15,
      },
      {
        kind: "method",
        name: "run",
        signature: "run() {}",
        exported: false,
        startLine: 3,
        startColumn: 2,
        endLine: 3,
        endColumn: 10,
      },
      {
        kind: "import",
        name: "./worker",
        signature: null,
        exported: false,
        startLine: 4,
        startColumn: 0,
        endLine: 4,
        endColumn: 27,
      },
    ]);
  });
});

describe("runExtractionPipeline", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("persists deterministic nodes and symbols through the graph store", async () => {
    const root = mkdtempSync(join(tmpdir(), "polaris-parser-pipeline-"));
    const sourcePath = join(root, "sample.ts");
    writeFileSync(sourcePath, "export function buildGraph() {}", "utf-8");

    const adapter = new GraphStoreAdapter({
      dbPath: join(".polaris", "graph", "graph.sqlite"),
      graphOutputPath: ".polaris/graph",
      repoRoot: root,
    });
    adapter.open();

    const functionName = createNode("identifier", "buildGraph", 0, 16, 0, 26);
    const functionNode = createNode("function_declaration", "export function buildGraph() {}", 0, 0, 0, 30, [functionName]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);
    const tree: ParseTreeLike = {
      rootNode: createNode("program", "", 0, 0, 1, 0, [createNode("export_statement", "", 0, 0, 0, 30, [functionNode])]),
    };

    mockedLoadTreeSitterRuntime.mockResolvedValue({
      parse: () => tree,
    });

    const first = await runExtractionPipeline([sourcePath], { graphStore: adapter });
    const second = await runExtractionPipeline([sourcePath], { graphStore: adapter });

    const db = adapter.getDatabase();
    const symbolRows = db
      .prepare("SELECT id, name, kind, exported FROM symbols ORDER BY id")
      .all() as Array<{ id: string; name: string; kind: string; exported: number }>;
    const nodeRows = db
      .prepare("SELECT id, type, name FROM nodes ORDER BY id")
      .all() as Array<{ id: string; type: string; name: string }>;

    expect(first.failedFiles).toBe(0);
    expect(second.failedFiles).toBe(0);
    expect(first.persistedSymbols).toBe(1);
    expect(second.persistedSymbols).toBe(1);
    expect(symbolRows).toHaveLength(1);
    expect(symbolRows[0]).toMatchObject({ name: "buildGraph", kind: "function", exported: 1 });
    expect(nodeRows).toHaveLength(1);
    expect(nodeRows[0]).toMatchObject({ type: "FUNCTION", name: "buildGraph" });

    adapter.close();
  });

  it("captures per-file failures as warnings without aborting remaining files", async () => {
    const root = mkdtempSync(join(tmpdir(), "polaris-parser-pipeline-errors-"));
    const goodPath = join(root, "good.js");
    const badPath = join(root, "missing.js");
    writeFileSync(goodPath, "function ok() {}", "utf-8");

    const adapter = new GraphStoreAdapter({
      dbPath: join(".polaris", "graph", "graph.sqlite"),
      graphOutputPath: ".polaris/graph",
      repoRoot: root,
    });
    adapter.open();

    const functionName = createNode("identifier", "ok", 0, 9, 0, 11);
    const functionNode = createNode("function_declaration", "function ok() {}", 0, 0, 0, 15, [functionName]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);
    const tree: ParseTreeLike = {
      rootNode: createNode("program", "", 0, 0, 1, 0, [functionNode]),
    };

    mockedLoadTreeSitterRuntime.mockResolvedValue({
      parse: () => tree,
    });

    const warnings: string[] = [];
    const result = await runExtractionPipeline([badPath, goodPath], {
      graphStore: adapter,
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    });

    expect(result.processedFiles).toBe(2);
    expect(result.succeededFiles).toBe(1);
    expect(result.failedFiles).toBe(1);
    expect(result.warnings.some((warning) => warning.includes("Extraction failed"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("missing.js"))).toBe(true);

    adapter.close();
  });
});

function createNode(
  type: string,
  text: string,
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
  children: SyntaxNodeLike[] = [],
): SyntaxNodeLike {
  const node: SyntaxNodeLike = {
    type,
    text,
    startPosition: { row: startRow, column: startColumn },
    endPosition: { row: endRow, column: endColumn },
    namedChildren: children,
    childForFieldName: () => null,
    parent: null,
  };

  for (const child of children) {
    child.parent = node;
  }

  return node;
}
