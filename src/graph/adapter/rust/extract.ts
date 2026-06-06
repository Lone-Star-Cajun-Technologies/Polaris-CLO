import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";

export function extractRustSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  walkNode(tree.rootNode, symbols, false);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language: "rust",
    symbols: deduped,
  };
}

function walkNode(node: SyntaxNodeLike, output: ExtractedSymbol[], insideImpl: boolean): void {
  const current = toExtractedSymbol(node, insideImpl);
  if (current) {
    output.push(current);
  }

  const nextInsideImpl = insideImpl || node.type === "impl_item";
  for (const child of node.namedChildren ?? []) {
    walkNode(child, output, nextInsideImpl);
  }
}

function toExtractedSymbol(node: SyntaxNodeLike, insideImpl: boolean): ExtractedSymbol | null {
  if (node.type === "use_declaration") {
    return buildSymbol(node, "import", extractUseName(node), null);
  }

  if (node.type === "struct_item" || node.type === "enum_item" || node.type === "trait_item") {
    return buildSymbol(node, "class", extractTypeName(node), null);
  }

  if (node.type === "function_item") {
    const kind: ExtractedSymbol["kind"] = insideImpl ? "method" : "function";
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
    exported: /\bpub\b/.test(node.text),
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

function extractUseName(node: SyntaxNodeLike): string | null {
  const argumentField = node.childForFieldName?.("argument");
  if (argumentField?.text?.trim()) {
    return argumentField.text.trim();
  }

  for (const child of node.namedChildren ?? []) {
    if (child.type === "use_list" || child.type === "scoped_identifier" || child.type === "identifier") {
      const text = child.text.trim();
      if (text.length > 0) {
        return text;
      }
    }
  }

  const byText = node.text.match(/^\s*(?:pub\s+)?use\s+([\s\S]+?)\s*;/m);
  return byText?.[1] ?? null;
}

function extractTypeName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  const byText = node.text.match(/\b(struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return byText?.[2] ?? null;
}

function extractFunctionName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  const byText = node.text.match(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
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
