import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";

export function extractSwiftSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  walkNode(tree.rootNode, symbols);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language: "swift",
    symbols: deduped,
  };
}

function walkNode(node: SyntaxNodeLike, output: ExtractedSymbol[]): void {
  const current = toExtractedSymbol(node);
  if (current) {
    output.push(current);
  }

  for (const child of node.namedChildren ?? []) {
    walkNode(child, output);
  }
}

function toExtractedSymbol(node: SyntaxNodeLike): ExtractedSymbol | null {
  if (CLASS_DECLARATION_TYPES.has(node.type)) {
    return buildSymbol(node, "class", extractDeclarationName(node), null);
  }

  if (node.type === "function_declaration") {
    const kind: ExtractedSymbol["kind"] = isMethodContext(node) ? "method" : "function";
    return buildSymbol(node, kind, extractFunctionName(node), sanitizeSignature(node.text));
  }

  if (node.type === "import_declaration") {
    return buildSymbol(node, "import", extractImportName(node), null);
  }

  return null;
}

function buildSymbol(
  node: SyntaxNodeLike,
  kind: ExtractedSymbol["kind"],
  name: string | null,
  signature: string | null,
): ExtractedSymbol | null {
  if (!name) {
    return null;
  }

  return {
    kind,
    name,
    signature,
    exported: !/\b(?:private|fileprivate)\b/.test(node.text),
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

function extractDeclarationName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  for (const child of node.namedChildren ?? []) {
    if (IDENTIFIER_NODE_TYPES.has(child.type) && child.text.trim().length > 0) {
      return child.text.trim();
    }
  }

  const byText = node.text.match(/\b(?:class|struct|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return byText?.[1] ?? null;
}

function extractFunctionName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  for (const child of node.namedChildren ?? []) {
    if (IDENTIFIER_NODE_TYPES.has(child.type) && child.text.trim().length > 0) {
      return child.text.trim();
    }
  }

  const byText = node.text.match(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  return byText?.[1] ?? null;
}

function extractImportName(node: SyntaxNodeLike): string | null {
  const byText = node.text.match(/^\s*import\s+(?:\w+\s+)?([A-Za-z_][A-Za-z0-9_.]*)\b/m);
  return byText?.[1] ?? null;
}

function isMethodContext(node: SyntaxNodeLike): boolean {
  let current = node.parent;
  while (current) {
    if (METHOD_CONTAINER_TYPES.has(current.type)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function sanitizeSignature(signature: string): string | null {
  const compact = signature.replace(/\s+/g, " ").trim();
  return compact.length === 0 ? null : compact;
}

function dedupeSymbols(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  const byFingerprint = new Map<string, ExtractedSymbol>();
  for (const symbol of symbols) {
    const fingerprint = [
      symbol.kind,
      symbol.name,
      symbol.startLine,
      symbol.startColumn,
      symbol.endLine,
      symbol.endColumn,
    ].join(":");
    byFingerprint.set(fingerprint, symbol);
  }
  return Array.from(byFingerprint.values());
}

function compareExtractedSymbols(left: ExtractedSymbol, right: ExtractedSymbol): number {
  return (
    left.startLine - right.startLine ||
    left.startColumn - right.startColumn ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn ||
    left.kind.localeCompare(right.kind) ||
    left.name.localeCompare(right.name)
  );
}

const CLASS_DECLARATION_TYPES = new Set(["class_declaration", "struct_declaration", "protocol_declaration"]);
const METHOD_CONTAINER_TYPES = new Set(["class_declaration", "struct_declaration", "extension_declaration"]);
const IDENTIFIER_NODE_TYPES = new Set(["identifier", "simple_identifier", "type_identifier"]);
