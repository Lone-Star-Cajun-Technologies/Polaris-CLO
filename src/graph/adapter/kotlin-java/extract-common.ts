import type { ExtractedSymbol } from "../types.js";
import type { SyntaxNodeLike } from "../../parser/loader.js";

export function walkNodes(node: SyntaxNodeLike, visit: (node: SyntaxNodeLike) => void): void {
  visit(node);
  for (const child of node.namedChildren ?? []) {
    walkNodes(child, visit);
  }
}

export function createSymbol(
  node: SyntaxNodeLike,
  kind: ExtractedSymbol["kind"],
  name: string | null,
  signature: string | null,
  exported: boolean,
): ExtractedSymbol | null {
  if (!name) {
    return null;
  }

  return {
    kind,
    name,
    signature,
    exported,
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

export function extractDeclaredName(
  node: SyntaxNodeLike,
  identifierNodeTypes: ReadonlySet<string>,
  fallbackPattern?: RegExp,
): string | null {
  const byField = node.childForFieldName?.("name");
  if (byField?.text?.trim()) {
    return byField.text.trim();
  }

  for (const child of node.namedChildren ?? []) {
    if (identifierNodeTypes.has(child.type) && child.text.trim().length > 0) {
      return child.text.trim();
    }
  }

  if (fallbackPattern) {
    return node.text.match(fallbackPattern)?.[1] ?? null;
  }

  return null;
}

export function sanitizeSignature(signature: string): string | null {
  const compact = signature.replace(/\s+/g, " ").trim();
  return compact.length === 0 ? null : compact;
}

export function dedupeAndSortSymbols(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
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

  const deduped = Array.from(byFingerprint.values());
  deduped.sort(compareSymbols);
  return deduped;
}

export function isMethodContext(node: SyntaxNodeLike, containerNodeTypes: ReadonlySet<string>): boolean {
  let current = node.parent;
  while (current) {
    if (containerNodeTypes.has(current.type)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function compareSymbols(left: ExtractedSymbol, right: ExtractedSymbol): number {
  return (
    left.startLine - right.startLine ||
    left.startColumn - right.startColumn ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn ||
    left.kind.localeCompare(right.kind) ||
    left.name.localeCompare(right.name)
  );
}
