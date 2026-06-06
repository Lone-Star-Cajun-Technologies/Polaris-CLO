import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";

export function extractDartSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  walkNode(tree.rootNode, symbols);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language: "dart",
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
  if (node.type === "class_definition") {
    return buildSymbol(node, "class", extractClassName(node), null);
  }

  if (node.type === "import_or_export") {
    return buildSymbol(node, "import", extractImportSpecifier(node), null);
  }

  if (FUNCTION_LIKE_TYPES.has(node.type)) {
    const kind: ExtractedSymbol["kind"] = hasClassAncestor(node) ? "method" : "function";
    return buildSymbol(node, kind, extractFunctionName(node), sanitizeSignature(node.text));
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
    exported: !name.startsWith("_"),
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

function extractClassName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  for (const child of node.namedChildren ?? []) {
    if (IDENTIFIER_NODE_TYPES.has(child.type) && child.text.trim().length > 0) {
      return child.text.trim();
    }
  }

  const byText = node.text.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
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

  const byText = node.text.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  return byText?.[1] ?? null;
}

function extractImportSpecifier(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("uri");
  if (byField?.text) {
    return normalizeQuotedSpecifier(byField.text);
  }

  const match = node.text.match(/^\s*(?:import|export)\s+['"]([^'"]+)['"]/m);
  return match?.[1] ?? null;
}

function normalizeQuotedSpecifier(value: string): string | null {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith("\"") && trimmed.endsWith("\""))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.length === 0 ? null : trimmed;
}

function hasClassAncestor(node: SyntaxNodeLike): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "class_definition") {
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

const FUNCTION_LIKE_TYPES = new Set(["function_signature", "method_signature"]);
const IDENTIFIER_NODE_TYPES = new Set(["identifier", "type_identifier"]);
