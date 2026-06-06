import { describe, expect, it } from "vitest";
import { createPythonAdapter } from "../index.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../../parser/loader.js";

describe("PythonAdapter", () => {
  it("extracts imports, classes, functions, and class methods", async () => {
    const importNode = createNode("import_statement", "import os, sys as system", 0, 0, 0, 24);
    const fromImportNode = createNode("import_from_statement", "from pkg.sub import item", 1, 0, 1, 24);

    const className = createNode("identifier", "Worker", 2, 6, 2, 12);
    const methodName = createNode("identifier", "run", 3, 8, 3, 11);
    const methodNode = createNode("function_definition", "def run(self): pass", 3, 2, 3, 20, [methodName]);
    methodNode.childForFieldName = (fieldName) => (fieldName === "name" ? methodName : null);

    const classNode = createNode("class_definition", "class Worker:\n  def run(self): pass", 2, 0, 3, 20, [
      className,
      methodNode,
    ]);
    classNode.childForFieldName = (fieldName) => (fieldName === "name" ? className : null);

    const functionName = createNode("identifier", "build", 4, 4, 4, 9);
    const functionNode = createNode("function_definition", "def build():\n  pass", 4, 0, 5, 6, [functionName]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("module", "", 0, 0, 6, 0, [importNode, fromImportNode, classNode, functionNode]),
    };

    const adapter = createPythonAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.py", "ignored");
    expect(extracted.language).toBe("python");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "os" },
      { kind: "import", name: "sys" },
      { kind: "import", name: "pkg.sub" },
      { kind: "class", name: "Worker" },
      { kind: "method", name: "run" },
      { kind: "function", name: "build" },
    ]);
  });

  it("accepts .pyi files", async () => {
    const functionName = createNode("identifier", "typed_fn", 0, 4, 0, 12);
    const functionNode = createNode("function_definition", "def typed_fn(x: int) -> int: ...", 0, 0, 0, 31, [functionName]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("module", "", 0, 0, 1, 0, [functionNode]),
    };

    const adapter = createPythonAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("types.pyi", "ignored");
    expect(extracted.symbols.map((symbol) => symbol.name)).toEqual(["typed_fn"]);
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
