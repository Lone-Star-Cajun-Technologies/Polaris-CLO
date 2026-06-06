import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";

export function extractGoSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  walkNode(tree.rootNode, symbols);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language: "go",
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
  if (node.type === "import_spec") {
    const name = extractImportPath(node);
    return buildSymbol(node, "import", name, null);
  }

  if (node.type === "type_spec") {
    const extracted = extractTypeName(node);
    if (!extracted) {
      return null;
    }
    return buildSymbol(node, "class", extracted, null);
  }

  if (node.type === "function_declaration") {
    return buildSymbol(node, "function", extractFunctionName(node), sanitizeSignature(node.text));
  }

  if (node.type === "method_declaration") {
    return buildSymbol(node, "method", extractFunctionName(node), sanitizeSignature(node.text));
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
    exported: /^[A-Z]/.test(name),
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

function extractImportPath(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("path");
  if (byField?.text) {
    return byField.text.replace(/^"|"$/g, "");
  }

  const byText = node.text.match(/"([^"]+)"/);
  return byText?.[1] ?? null;
}

function extractTypeName(node: SyntaxNodeLike): string | null {
  const typeNode = node.childForFieldName?.("type");
  if (!typeNode || (typeNode.type !== "struct_type" && typeNode.type !== "interface_type")) {
    return null;
  }

  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  const byText = node.text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b/);
  return byText?.[1] ?? null;
}

function extractFunctionName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  const byText = node.text.match(/\bfunc\b(?:\s*\([^)]*\))?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  return byText?.[1] ?? null;
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
