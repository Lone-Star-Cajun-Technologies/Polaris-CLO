import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";

export function extractPythonSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  walkNode(tree.rootNode, symbols, 0, 0);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language: "python",
    symbols: deduped,
  };
}

function walkNode(node: SyntaxNodeLike, output: ExtractedSymbol[], classDepth: number, functionDepth: number): void {
  const current = toExtractedSymbols(node, classDepth, functionDepth);
  if (current.length > 0) {
    output.push(...current);
  }

  const nextClassDepth = node.type === "class_definition" ? classDepth + 1 : classDepth;
  const nextFunctionDepth = node.type === "function_definition" ? functionDepth + 1 : functionDepth;
  for (const child of node.namedChildren ?? []) {
    walkNode(child, output, nextClassDepth, nextFunctionDepth);
  }
}

function toExtractedSymbols(node: SyntaxNodeLike, classDepth: number, functionDepth: number): ExtractedSymbol[] {
  if (node.type === "class_definition") {
    const name = extractClassName(node);
    const symbol = buildSymbol(node, "class", name, null);
    return symbol ? [symbol] : [];
  }

  if (node.type === "function_definition") {
    const name = extractFunctionName(node);
    const kind: ExtractedSymbol["kind"] = (classDepth > 0 && functionDepth === 0) ? "method" : "function";
    const signature = sanitizeSignature(node.text);
    const symbol = buildSymbol(node, kind, name, signature);
    return symbol ? [symbol] : [];
  }

  if (node.type === "import_statement") {
    return extractImportNames(node).flatMap((name) => {
      const symbol = buildSymbol(node, "import", name, null);
      return symbol ? [symbol] : [];
    });
  }

  if (node.type === "import_from_statement") {
    const symbol = buildSymbol(node, "import", extractFromImportName(node), null);
    return symbol ? [symbol] : [];
  }

  return [];
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

  const byText = node.text.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return byText?.[1] ?? null;
}

function extractFunctionName(node: SyntaxNodeLike): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  const byText = node.text.match(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  return byText?.[1] ?? null;
}

function extractImportNames(node: SyntaxNodeLike): string[] {
  const byText = node.text.match(/^\s*import\s+(.+)$/m)?.[1];
  if (!byText) {
    return [];
  }

  return byText
    .split(",")
    .map((part) => part.trim().replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*$/, ""))
    .filter((part) => part.length > 0);
}

function extractFromImportName(node: SyntaxNodeLike): string | null {
  const byText = node.text.match(/^\s*from\s+([.\w]+)\s+import\b/m);
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
