import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";

export function extractCppSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  walkNode(tree.rootNode, symbols);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language: "cpp",
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

  if (node.type === "class_specifier" || node.type === "struct_specifier") {
    const name = extractTypeName(node);
    return buildSymbol(node, "class", name, null);
  }

  if (node.type === "function_definition" || node.type === "declaration") {
    const functionDeclarator =
      node.type === "declaration"
        ? findDescendant(node, "function_declarator") ?? findDescendant(node, "function_declarator")
        : findDescendant(node, "function_declarator") ?? node;

    if (!functionDeclarator) {
      return null;
    }

    const extracted = extractFunctionName(functionDeclarator.text);
    if (!extracted) {
      return null;
    }
    const signature = sanitizeSignature(node.text);
    const symbolKind = isMethod(node, extracted.rawName) ? "method" : "function";
    return buildSymbol(node, symbolKind, extracted.name, signature);
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
    exported: /\b(public|extern)\b/.test(node.text),
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

function extractTypeName(node: SyntaxNodeLike): string | null {
  const nameNode = node.childForFieldName?.("name");
  if (nameNode?.text?.trim()) {
    return nameNode.text.trim();
  }

  const byText = node.text.match(/\b(class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return byText?.[2] ?? null;
}

function extractFunctionName(text: string): { name: string; rawName: string } | null {
  const compact = text.replace(/\s+/g, " ").trim();
  const match = compact.match(/([~A-Za-z_][A-Za-z0-9_:~]*)\s*\(/);
  if (!match) {
    return null;
  }

  const rawName = match[1];
  const simple = rawName.includes("::") ? rawName.split("::").at(-1) ?? rawName : rawName;
  return { name: simple, rawName };
}

function isMethod(node: SyntaxNodeLike, rawName: string): boolean {
  let current = node.parent ?? null;
  while (current) {
    if (current.type === "class_specifier" || current.type === "struct_specifier") {
      return true;
    }
    current = current.parent ?? null;
  }

  return false;
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
