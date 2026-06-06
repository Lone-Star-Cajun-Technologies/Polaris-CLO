import { describe, expect, it } from "vitest";
import { createCppAdapter } from "../index.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../../parser/loader.js";

describe("CppAdapter", () => {
  it("extracts includes, classes, functions, and methods", async () => {
    const includeNode = createNode("preproc_include", "#include <vector>", 0, 0, 0, 17);

    const className = createNode("type_identifier", "Widget", 1, 6, 1, 12);
    const classNode = createNode("class_specifier", "class Widget {};", 1, 0, 1, 16, [className]);
    classNode.childForFieldName = (fieldName) => (fieldName === "name" ? className : null);

    const functionDeclarator = createNode("function_declarator", "build()", 2, 5, 2, 12);
    const functionNode = createNode("function_definition", "void build() {}", 2, 0, 2, 15, [functionDeclarator]);

    const methodDeclarator = createNode("function_declarator", "Widget::render()", 3, 5, 3, 21);
    const methodNode = createNode("declaration", "void Widget::render();", 3, 0, 3, 22, [methodDeclarator]);

    // ns is not a class — ns::func() should be classified as a free function
    const nsFuncDeclarator = createNode("function_declarator", "ns::func()", 4, 5, 4, 15);
    const nsFuncNode = createNode("declaration", "void ns::func();", 4, 0, 4, 16, [nsFuncDeclarator]);

    const tree: ParseTreeLike = {
      rootNode: createNode("translation_unit", "", 0, 0, 5, 0, [includeNode, classNode, functionNode, methodNode, nsFuncNode]),
    };

    const adapter = createCppAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.cpp", "ignored");
    expect(extracted.language).toBe("cpp");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "vector" },
      { kind: "class", name: "Widget" },
      { kind: "function", name: "build" },
      { kind: "method", name: "render" },
      { kind: "function", name: "func" },
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
