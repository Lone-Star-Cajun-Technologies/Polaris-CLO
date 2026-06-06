import { describe, expect, it } from "vitest";
import { createCAdapter } from "../index.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../../parser/loader.js";

describe("CAdapter", () => {
  it("extracts includes, structs, and functions", async () => {
    const includeNode = createNode("preproc_include", '#include "stdio.h"', 0, 0, 0, 18);
    const structName = createNode("type_identifier", "Thing", 1, 7, 1, 12);
    const structNode = createNode("struct_specifier", "struct Thing { int x; };", 1, 0, 1, 24, [structName]);
    structNode.childForFieldName = (fieldName) => (fieldName === "name" ? structName : null);

    const functionName = createNode("identifier", "run", 2, 5, 2, 8);
    const functionDeclarator = createNode("function_declarator", "run(void)", 2, 5, 2, 14, [functionName]);
    const functionNode = createNode("function_definition", "int run(void) { return 0; }", 2, 0, 2, 28, [functionDeclarator]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "declarator" ? functionDeclarator : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("translation_unit", "", 0, 0, 3, 0, [includeNode, structNode, functionNode]),
    };

    const adapter = createCAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.c", "ignored");
    expect(extracted.language).toBe("c");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "stdio.h" },
      { kind: "class", name: "Thing" },
      { kind: "function", name: "run" },
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
