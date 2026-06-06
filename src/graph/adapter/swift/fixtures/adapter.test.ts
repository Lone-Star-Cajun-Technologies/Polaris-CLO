import { describe, expect, it } from "vitest";
import { createSwiftAdapter } from "../index.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../../parser/loader.js";

describe("SwiftAdapter", () => {
  it("extracts imports, class-like declarations, functions, and methods", async () => {
    const importNode = createNode("import_declaration", "import Foundation", 0, 0, 0, 17);

    const className = createNode("identifier", "Worker", 2, 6, 2, 12);
    const classMethodName = createNode("identifier", "run", 3, 7, 3, 10);
    const classMethodNode = createNode("function_declaration", "func run() {}", 3, 2, 3, 14, [classMethodName]);
    classMethodNode.childForFieldName = (fieldName) => (fieldName === "name" ? classMethodName : null);
    const classNode = createNode("class_declaration", "class Worker { func run() {} }", 2, 0, 3, 15, [className, classMethodNode]);
    classNode.childForFieldName = (fieldName) => (fieldName === "name" ? className : null);

    const structName = createNode("identifier", "Payload", 5, 7, 5, 14);
    const structNode = createNode("struct_declaration", "struct Payload {}", 5, 0, 5, 16, [structName]);
    structNode.childForFieldName = (fieldName) => (fieldName === "name" ? structName : null);

    const protocolName = createNode("identifier", "Runnable", 6, 9, 6, 17);
    const protocolNode = createNode("protocol_declaration", "protocol Runnable {}", 6, 0, 6, 19, [protocolName]);
    protocolNode.childForFieldName = (fieldName) => (fieldName === "name" ? protocolName : null);

    const functionName = createNode("identifier", "build", 8, 5, 8, 10);
    const functionNode = createNode("function_declaration", "func build() {}", 8, 0, 8, 14, [functionName]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);

    const extensionMethodName = createNode("identifier", "reset", 10, 7, 10, 12);
    const extensionMethodNode = createNode("function_declaration", "func reset() {}", 10, 2, 10, 16, [extensionMethodName]);
    extensionMethodNode.childForFieldName = (fieldName) => (fieldName === "name" ? extensionMethodName : null);
    const extensionNode = createNode("extension_declaration", "extension Worker { func reset() {} }", 9, 0, 10, 17, [
      extensionMethodNode,
    ]);

    const tree: ParseTreeLike = {
      rootNode: createNode("source_file", "", 0, 0, 11, 0, [
        importNode,
        classNode,
        structNode,
        protocolNode,
        functionNode,
        extensionNode,
      ]),
    };

    const adapter = createSwiftAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.swift", "ignored");
    expect(extracted.language).toBe("swift");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "Foundation" },
      { kind: "class", name: "Worker" },
      { kind: "method", name: "run" },
      { kind: "class", name: "Payload" },
      { kind: "class", name: "Runnable" },
      { kind: "function", name: "build" },
      { kind: "method", name: "reset" },
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
