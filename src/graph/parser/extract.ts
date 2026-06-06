import type { GraphSymbolKind } from "../store/types.js";
import type { ParseTreeLike, SupportedParserLanguage, SyntaxNodeLike } from "./loader.js";

export interface ExtractedSymbol {
  kind: Exclude<GraphSymbolKind, "unknown">;
  name: string;
  signature: string | null;
  exported: boolean;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface ExtractedFileSymbols {
  language: SupportedParserLanguage;
  symbols: ExtractedSymbol[];
}

export function extractSymbolsFromTree(
  tree: ParseTreeLike,
  language: SupportedParserLanguage,
): ExtractedFileSymbols {
  const symbols: ExtractedSymbol[] = [];
  walkNode(tree.rootNode, symbols);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language,
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
  switch (node.type) {
    case "function_declaration":
      return buildSymbol(node, "function", extractIdentifierName(node), sanitizeSignature(node.text));
    case "class_declaration":
      return buildSymbol(node, "class", extractIdentifierName(node), null);
    case "method_definition":
    case "method_signature":
    case "abstract_method_signature":
      return buildSymbol(node, "method", extractIdentifierName(node), sanitizeSignature(node.text));
    case "import_statement":
      return buildSymbol(node, "import", extractImportSource(node), null);
    default:
      return null;
  }
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
    exported: isExported(node),
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

function extractIdentifierName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text) {
    return byField.text.trim();
  }

  for (const child of node.namedChildren ?? []) {
    if (IDENTIFIER_NODE_TYPES.has(child.type) && child.text.trim().length > 0) {
      return child.text.trim();
    }
  }

  return null;
}

function extractImportSource(node: SyntaxNodeLike): string | null {
  const sourceNode = node.childForFieldName?.("source");
  const raw = sourceNode?.text ?? node.text;
  const match = raw.match(/["']([^"']+)["']/);
  return match?.[1] ?? null;
}

function isExported(node: SyntaxNodeLike): boolean {
  if (node.type.startsWith("export_")) {
    return true;
  }

  if (node.text.startsWith("export ")) {
    return true;
  }

  let current = node.parent ?? null;
  while (current) {
    if (current.type.startsWith("export_")) {
      return true;
    }
    current = current.parent ?? null;
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

const IDENTIFIER_NODE_TYPES = new Set(["identifier", "property_identifier", "private_property_identifier"]);
