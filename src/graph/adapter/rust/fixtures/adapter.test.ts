import { describe, expect, it } from "vitest";
import { createRustAdapter } from "../index.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../../parser/loader.js";

describe("RustAdapter", () => {
  it("extracts use declarations, types, functions, and impl methods", async () => {
    const useNode = createNode("use_declaration", "use std::io::{self, Write};", 0, 0, 0, 28);

    const structName = createNode("type_identifier", "Worker", 1, 11, 1, 17);
    const structNode = createNode("struct_item", "pub struct Worker {}", 1, 0, 1, 20, [structName]);
    structNode.childForFieldName = (fieldName) => (fieldName === "name" ? structName : null);

    const enumName = createNode("type_identifier", "Mode", 2, 5, 2, 9);
    const enumNode = createNode("enum_item", "enum Mode { A }", 2, 0, 2, 15, [enumName]);
    enumNode.childForFieldName = (fieldName) => (fieldName === "name" ? enumName : null);

    const traitName = createNode("type_identifier", "Runner", 3, 6, 3, 12);
    const traitNode = createNode("trait_item", "trait Runner {}", 3, 0, 3, 14, [traitName]);
    traitNode.childForFieldName = (fieldName) => (fieldName === "name" ? traitName : null);

    const functionName = createNode("identifier", "build", 4, 7, 4, 12);
    const functionNode = createNode("function_item", "fn build() {}", 4, 0, 4, 12, [functionName]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);

    const methodName = createNode("identifier", "run", 5, 7, 5, 10);
    const methodNode = createNode("function_item", "pub fn run(&self) {}", 5, 2, 5, 21, [methodName]);
    methodNode.childForFieldName = (fieldName) => (fieldName === "name" ? methodName : null);
    const implNode = createNode("impl_item", "impl Worker { pub fn run(&self) {} }", 5, 0, 5, 34, [methodNode]);

    const tree: ParseTreeLike = {
      rootNode: createNode("source_file", "", 0, 0, 6, 0, [useNode, structNode, enumNode, traitNode, functionNode, implNode]),
    };

    const adapter = createRustAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.rs", "ignored");
    expect(extracted.language).toBe("rust");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "std::io::{self, Write}" },
      { kind: "class", name: "Worker" },
      { kind: "class", name: "Mode" },
      { kind: "class", name: "Runner" },
      { kind: "function", name: "build" },
      { kind: "method", name: "run" },
    ]);
  });

  it("keeps non-impl functions as function symbols", async () => {
    const functionName = createNode("identifier", "helper", 0, 3, 0, 9);
    const functionNode = createNode("function_item", "fn helper() {}", 0, 0, 0, 13, [functionName]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("source_file", "", 0, 0, 1, 0, [functionNode]),
    };

    const adapter = createRustAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.rs", "ignored");
    expect(extracted.symbols.map((symbol) => symbol.kind)).toEqual(["function"]);
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
