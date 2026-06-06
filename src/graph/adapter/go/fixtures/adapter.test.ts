import { describe, expect, it } from "vitest";
import { createGoAdapter } from "../index.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../../parser/loader.js";

describe("GoAdapter", () => {
  it("extracts imports, types, functions, and methods", async () => {
    const importPathOne = createNode("interpreted_string_literal", "\"fmt\"", 1, 2, 1, 7);
    const importSpecOne = createNode("import_spec", "\"fmt\"", 1, 0, 1, 7, [importPathOne]);
    importSpecOne.childForFieldName = (fieldName) => (fieldName === "path" ? importPathOne : null);

    const importPathTwo = createNode("interpreted_string_literal", "\"net/http\"", 2, 2, 2, 12);
    const importSpecTwo = createNode("import_spec", "\"net/http\"", 2, 0, 2, 12, [importPathTwo]);
    importSpecTwo.childForFieldName = (fieldName) => (fieldName === "path" ? importPathTwo : null);

    const structName = createNode("type_identifier", "Worker", 4, 5, 4, 11);
    const structType = createNode("struct_type", "struct {}", 4, 12, 4, 21);
    const structSpec = createNode("type_spec", "Worker struct {}", 4, 0, 4, 21, [structName, structType]);
    structSpec.childForFieldName = (fieldName) => {
      if (fieldName === "name") {
        return structName;
      }
      if (fieldName === "type") {
        return structType;
      }
      return null;
    };

    const interfaceName = createNode("type_identifier", "Runner", 5, 5, 5, 11);
    const interfaceType = createNode("interface_type", "interface {}", 5, 12, 5, 24);
    const interfaceSpec = createNode("type_spec", "Runner interface {}", 5, 0, 5, 24, [interfaceName, interfaceType]);
    interfaceSpec.childForFieldName = (fieldName) => {
      if (fieldName === "name") {
        return interfaceName;
      }
      if (fieldName === "type") {
        return interfaceType;
      }
      return null;
    };

    const functionName = createNode("identifier", "Build", 7, 5, 7, 10);
    const functionNode = createNode("function_declaration", "func Build() {}", 7, 0, 7, 14, [functionName]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);

    const methodName = createNode("field_identifier", "Run", 8, 14, 8, 17);
    const methodNode = createNode("method_declaration", "func (w Worker) Run() {}", 8, 0, 8, 24, [methodName]);
    methodNode.childForFieldName = (fieldName) => (fieldName === "name" ? methodName : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("source_file", "", 0, 0, 9, 0, [
        importSpecOne,
        importSpecTwo,
        structSpec,
        interfaceSpec,
        functionNode,
        methodNode,
      ]),
    };

    const adapter = createGoAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.go", "ignored");
    expect(extracted.language).toBe("go");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "fmt" },
      { kind: "import", name: "net/http" },
      { kind: "class", name: "Worker" },
      { kind: "class", name: "Runner" },
      { kind: "function", name: "Build" },
      { kind: "method", name: "Run" },
    ]);
  });

  it("ignores non-struct/interface type specs", async () => {
    const aliasName = createNode("type_identifier", "Counter", 0, 5, 0, 12);
    const aliasType = createNode("type_identifier", "int", 0, 13, 0, 16);
    const aliasSpec = createNode("type_spec", "Counter int", 0, 0, 0, 16, [aliasName, aliasType]);
    aliasSpec.childForFieldName = (fieldName) => {
      if (fieldName === "name") {
        return aliasName;
      }
      if (fieldName === "type") {
        return aliasType;
      }
      return null;
    };

    const tree: ParseTreeLike = {
      rootNode: createNode("source_file", "", 0, 0, 1, 0, [aliasSpec]),
    };

    const adapter = createGoAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.go", "ignored");
    expect(extracted.symbols).toEqual([]);
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
