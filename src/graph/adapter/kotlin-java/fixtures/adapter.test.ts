import { describe, expect, it } from "vitest";
import { createJavaAdapter, createKotlinAdapter } from "../index.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../../parser/loader.js";

describe("JavaAdapter", () => {
  it("extracts imports, classes/interfaces, and methods", async () => {
    const importNode = createNode("import_declaration", "import java.util.List;", 0, 0, 0, 22);

    const className = createNode("identifier", "Worker", 1, 13, 1, 19);
    const classMethodName = createNode("identifier", "run", 2, 14, 2, 17);
    const classMethodNode = createNode("method_declaration", "public void run() {}", 2, 2, 2, 21, [classMethodName]);
    classMethodNode.childForFieldName = (fieldName) => (fieldName === "name" ? classMethodName : null);
    const classNode = createNode("class_declaration", "public class Worker {}", 1, 0, 2, 22, [className, classMethodNode]);
    classNode.childForFieldName = (fieldName) => (fieldName === "name" ? className : null);

    const interfaceName = createNode("identifier", "Runnable", 4, 17, 4, 25);
    const interfaceMethodName = createNode("identifier", "execute", 5, 7, 5, 14);
    const interfaceMethodNode = createNode("method_declaration", "void execute();", 5, 2, 5, 17, [interfaceMethodName]);
    interfaceMethodNode.childForFieldName = (fieldName) => (fieldName === "name" ? interfaceMethodName : null);
    const interfaceNode = createNode("interface_declaration", "public interface Runnable {}", 4, 0, 5, 18, [
      interfaceName,
      interfaceMethodNode,
    ]);
    interfaceNode.childForFieldName = (fieldName) => (fieldName === "name" ? interfaceName : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("program", "", 0, 0, 6, 0, [importNode, classNode, interfaceNode]),
    };

    const adapter = createJavaAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.java", "ignored");
    expect(extracted.language).toBe("java");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "java.util.List" },
      { kind: "class", name: "Worker" },
      { kind: "method", name: "run" },
      { kind: "class", name: "Runnable" },
      { kind: "method", name: "execute" },
    ]);
  });
});

describe("KotlinAdapter", () => {
  it("extracts imports, class/object declarations, top-level functions, and methods", async () => {
    const importNode = createNode("import_header", "import kotlin.collections.List", 0, 0, 0, 30);

    const className = createNode("identifier", "Worker", 2, 6, 2, 12);
    const classMethodName = createNode("identifier", "run", 3, 6, 3, 9);
    const classMethodNode = createNode("function_declaration", "fun run() {}", 3, 2, 3, 13, [classMethodName]);
    classMethodNode.childForFieldName = (fieldName) => (fieldName === "name" ? classMethodName : null);
    const classBody = createNode("class_body", "{ fun run() {} }", 2, 13, 3, 15, [classMethodNode]);
    const classNode = createNode("class_declaration", "class Worker { fun run() {} }", 2, 0, 3, 15, [className, classBody]);
    classNode.childForFieldName = (fieldName) => (fieldName === "name" ? className : null);

    const objectName = createNode("identifier", "Singleton", 5, 7, 5, 16);
    const objectMethodName = createNode("identifier", "reset", 6, 6, 6, 11);
    const objectMethodNode = createNode("function_declaration", "fun reset() {}", 6, 2, 6, 15, [objectMethodName]);
    objectMethodNode.childForFieldName = (fieldName) => (fieldName === "name" ? objectMethodName : null);
    const objectBody = createNode("class_body", "{ fun reset() {} }", 5, 17, 6, 17, [objectMethodNode]);
    const objectNode = createNode("object_declaration", "object Singleton { fun reset() {} }", 5, 0, 6, 17, [
      objectName,
      objectBody,
    ]);
    objectNode.childForFieldName = (fieldName) => (fieldName === "name" ? objectName : null);

    const functionName = createNode("identifier", "build", 8, 4, 8, 9);
    const functionNode = createNode("function_declaration", "fun build() {}", 8, 0, 8, 13, [functionName]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("source_file", "", 0, 0, 9, 0, [importNode, classNode, objectNode, functionNode]),
    };

    const adapter = createKotlinAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.kt", "ignored");
    expect(extracted.language).toBe("kotlin");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "kotlin.collections.List" },
      { kind: "class", name: "Worker" },
      { kind: "method", name: "run" },
      { kind: "class", name: "Singleton" },
      { kind: "method", name: "reset" },
      { kind: "function", name: "build" },
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
