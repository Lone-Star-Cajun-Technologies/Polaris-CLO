import { describe, expect, it } from "vitest";
import { createCSharpAdapter } from "../index.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../../parser/loader.js";

describe("CSharpAdapter", () => {
  it("extracts using directives, classes, methods, and static methods", async () => {
    const usingNode = createNode("using_directive", "using System.Linq;", 0, 0, 0, 18);

    const className = createNode("identifier", "Worker", 1, 6, 1, 12);
    const classNode = createNode("class_declaration", "public class Worker {}", 1, 0, 1, 21, [className]);
    classNode.childForFieldName = (fieldName) => (fieldName === "name" ? className : null);

    const methodName = createNode("identifier", "Run", 2, 15, 2, 18);
    const methodNode = createNode("method_declaration", "public void Run() {}", 2, 0, 2, 20, [methodName]);
    methodNode.childForFieldName = (fieldName) => (fieldName === "name" ? methodName : null);

    const staticName = createNode("identifier", "Build", 3, 24, 3, 29);
    const staticNode = createNode("method_declaration", "public static void Build() {}", 3, 0, 3, 29, [staticName]);
    staticNode.childForFieldName = (fieldName) => (fieldName === "name" ? staticName : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("compilation_unit", "", 0, 0, 4, 0, [usingNode, classNode, methodNode, staticNode]),
    };

    const adapter = createCSharpAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.cs", "ignored");
    expect(extracted.language).toBe("csharp");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "System.Linq" },
      { kind: "class", name: "Worker" },
      { kind: "method", name: "Run" },
      { kind: "function", name: "Build" },
    ]);
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
