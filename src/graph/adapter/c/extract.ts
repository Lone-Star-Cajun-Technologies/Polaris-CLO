import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";

export function extractCSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  walkNode(tree.rootNode, symbols);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language: "c",
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
  if (node.type === "preproc_include") {
    const include = extractIncludeName(node.text);
    if (!include) {
      return null;
    }
    return buildSymbol(node, "import", include, null);
  }

  if (node.type === "struct_specifier") {
    const name = extractStructName(node);
    return buildSymbol(node, "class", name, null);
  }

  if (node.type === "function_definition" || node.type === "declaration") {
    const functionNode = node.type === "declaration" ? findDescendant(node, "function_declarator") : node;
    if (!functionNode) {
      return null;
    }

    const name = extractFunctionName(functionNode);
    const signature = sanitizeSignature(node.text);
    return buildSymbol(node, "function", name, signature);
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
    exported: /\bextern\b/.test(node.text),
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

function extractIncludeName(text: string): string | null {
  const match = text.match(/#include\s*[<"]([^>"]+)[>"]/);
  return match?.[1] ?? null;
}

function extractStructName(node: SyntaxNodeLike): string | null {
  const nameNode = node.childForFieldName?.("name");
  if (nameNode?.text?.trim()) {
    return nameNode.text.trim();
  }

  const match = node.text.match(/\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1] ?? null;
}

function extractFunctionName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("declarator") ?? node.childForFieldName?.("name");
  if (byField) {
    const found = extractIdentifier(byField);
    if (found) {
      return found;
    }
  }
  return extractIdentifier(node);
}

function extractIdentifier(node: SyntaxNodeLike): string | null {
  if (IDENTIFIER_NODE_TYPES.has(node.type) && node.text.trim().length > 0) {
    return node.text.trim();
  }

  for (const child of node.namedChildren ?? []) {
    const found = extractIdentifier(child);
    if (found) {
      return found;
    }
  }

  const match = node.text.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  return match?.[1] ?? null;
}

function findDescendant(node: SyntaxNodeLike, type: string): SyntaxNodeLike | null {
  if (node.type === type) {
    return node;
  }

  for (const child of node.namedChildren ?? []) {
    const found = findDescendant(child, type);
    if (found) {
      return found;
    }
  }

  return null;
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

const IDENTIFIER_NODE_TYPES = new Set(["identifier", "field_identifier", "type_identifier"]);
