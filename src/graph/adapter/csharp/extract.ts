import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";

export function extractCSharpSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  walkNode(tree.rootNode, symbols);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language: "csharp",
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
  if (node.type === "using_directive") {
    const name = extractUsingName(node);
    return buildSymbol(node, "import", name, null);
  }

  if (node.type === "class_declaration") {
    const name = extractName(node);
    return buildSymbol(node, "class", name, null);
  }

  if (node.type === "method_declaration") {
    const name = extractName(node);
    const signature = sanitizeSignature(node.text);
    const kind: ExtractedSymbol["kind"] = isStatic(node) ? "function" : "method";
    return buildSymbol(node, kind, name, signature);
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
    exported: /\bpublic\b/.test(node.text),
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

function extractUsingName(node: SyntaxNodeLike): string | null {
  const match = node.text.match(/\busing\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/);
  return match?.[1] ?? null;
}

function extractName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  for (const child of node.namedChildren ?? []) {
    if (IDENTIFIER_NODE_TYPES.has(child.type) && child.text.trim().length > 0) {
      return child.text.trim();
    }
  }

  const methodMatch = node.text.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (methodMatch) {
    return methodMatch[1];
  }
  const classMatch = node.text.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return classMatch?.[1] ?? null;
}

function isStatic(node: SyntaxNodeLike): boolean {
  if (/\bstatic\b/.test(node.text)) {
    return true;
  }

  const modifiers = node.childForFieldName?.("modifiers");
  return Boolean(modifiers?.text && /\bstatic\b/.test(modifiers.text));
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

const IDENTIFIER_NODE_TYPES = new Set(["identifier"]);
