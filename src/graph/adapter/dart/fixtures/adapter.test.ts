import { describe, expect, it } from "vitest";
import { createDartAdapter } from "../index.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../../parser/loader.js";

describe("DartAdapter", () => {
  it("extracts imports, classes, top-level functions, and class methods", async () => {
    const importUriDart = createNode("uri", "'dart:async'", 0, 7, 0, 19);
    const importDart = createNode("import_or_export", "import 'dart:async';", 0, 0, 0, 20, [importUriDart]);
    importDart.childForFieldName = (fieldName) => (fieldName === "uri" ? importUriDart : null);

    const importUriPackage = createNode("uri", "'package:flutter/widgets.dart'", 1, 7, 1, 36);
    const importPackage = createNode(
      "import_or_export",
      "import 'package:flutter/widgets.dart';",
      1,
      0,
      1,
      37,
      [importUriPackage],
    );
    importPackage.childForFieldName = (fieldName) => (fieldName === "uri" ? importUriPackage : null);

    const className = createNode("type_identifier", "WorkerCard", 3, 6, 3, 16);
    const methodName = createNode("identifier", "build", 4, 9, 4, 14);
    const methodNode = createNode("method_signature", "Widget build(BuildContext context) {}", 4, 2, 4, 37, [methodName]);
    methodNode.childForFieldName = (fieldName) => (fieldName === "name" ? methodName : null);
    const classNode = createNode(
      "class_definition",
      "class WorkerCard extends StatelessWidget { Widget build(BuildContext context) {} }",
      3,
      0,
      4,
      38,
      [className, methodNode],
    );
    classNode.childForFieldName = (fieldName) => (fieldName === "name" ? className : null);

    const functionName = createNode("identifier", "buildWorker", 7, 3, 7, 14);
    const functionNode = createNode("function_signature", "WorkerCard buildWorker() => WorkerCard();", 7, 0, 7, 37, [
      functionName,
    ]);
    functionNode.childForFieldName = (fieldName) => (fieldName === "name" ? functionName : null);

    const tree: ParseTreeLike = {
      rootNode: createNode("program", "", 0, 0, 8, 0, [importDart, importPackage, classNode, functionNode]),
    };

    const adapter = createDartAdapter({
      loadRuntime: async () => ({
        parse: () => tree,
      }),
    });

    const extracted = await adapter.extractSymbols("sample.dart", "ignored");
    expect(extracted.language).toBe("dart");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "import", name: "dart:async" },
      { kind: "import", name: "package:flutter/widgets.dart" },
      { kind: "class", name: "WorkerCard" },
      { kind: "method", name: "build" },
      { kind: "function", name: "buildWorker" },
    ]);
  });

  it("resolves package and relative imports", () => {
    const adapter = createDartAdapter({
      loadRuntime: async () => {
        throw new Error("not used");
      },
    });

    expect(adapter.resolveImportSpecifier("package:app/widgets/card.dart", { fromFilePath: "lib/main.dart" })).toBe(
      "package:app/widgets/card.dart",
    );
    expect(adapter.resolveImportSpecifier("./util", { fromFilePath: "lib/main.dart" })).toBe("./util.dart");
    expect(adapter.resolveImportSpecifier("./util", { fromFilePath: "lib/main.dart", candidateExtensions: [".g.dart"] })).toBe(
      "./util.g.dart",
    );
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
