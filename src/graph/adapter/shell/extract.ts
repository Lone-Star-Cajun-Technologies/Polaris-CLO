import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";

export function extractShellSymbolsFromSource(source: string): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  const lineStarts = buildLineStarts(source);

  collectMatches(source, /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\))?\s*\{/gm, symbols, lineStarts);
  collectMatches(source, /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/gm, symbols, lineStarts, true);

  const deduped = dedupeSymbols(symbols);
  deduped.sort(compareExtractedSymbols);

  return {
    language: "shell",
    symbols: deduped,
  };
}

function collectMatches(
  source: string,
  pattern: RegExp,
  output: ExtractedSymbol[],
  lineStarts: number[],
  skipKeywords = false,
): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (!name) {
      continue;
    }
    if (skipKeywords && SHELL_KEYWORDS.has(name)) {
      continue;
    }

    const startIndex = match.index;
    const endIndex = startIndex + match[0].length;
    const start = indexToPoint(startIndex, lineStarts);
    const end = indexToPoint(endIndex, lineStarts);

    output.push({
      kind: "function",
      name,
      signature: sanitizeSignature(match[0]),
      exported: false,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
    });
  }
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function indexToPoint(index: number, lineStarts: number[]): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineStarts[mid];
    const nextStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.POSITIVE_INFINITY;
    if (index >= start && index < nextStart) {
      return { line: mid + 1, column: index - start };
    }
    if (index < start) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  const fallbackLine = lineStarts.length;
  return { line: fallbackLine, column: index - lineStarts[fallbackLine - 1] };
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

const SHELL_KEYWORDS = new Set(["if", "for", "while", "case", "select", "until", "time", "coproc"]);
