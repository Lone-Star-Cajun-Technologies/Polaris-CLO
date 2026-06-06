export type SvelteScriptLanguage = "javascript" | "typescript";

export interface SvelteScriptBlock {
  content: string;
  language: SvelteScriptLanguage;
  startLine: number;
  startColumn: number;
}

export function extractSvelteScriptBlocks(source: string): SvelteScriptBlock[] {
  const blocks: SvelteScriptBlock[] = [];
  const scriptPattern = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/gi;

  for (const match of source.matchAll(scriptPattern)) {
    const fullMatch = match[0];
    const attributes = match[1] ?? "";
    const content = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const tagEndOffset = fullMatch.indexOf(">") + 1;
    const contentStartIndex = matchIndex + tagEndOffset;
    const position = toLineColumn(source, contentStartIndex);

    blocks.push({
      content,
      language: detectScriptLanguage(attributes),
      startLine: position.line,
      startColumn: position.column,
    });
  }

  return blocks;
}

function detectScriptLanguage(attributes: string): SvelteScriptLanguage {
  const langMatch = attributes.match(/lang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  const rawLang = (langMatch?.[1] ?? langMatch?.[2] ?? langMatch?.[3] ?? "").trim().toLowerCase();
  return rawLang === "ts" || rawLang === "typescript" ? "typescript" : "javascript";
}

function toLineColumn(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") {
      line += 1;
      column = 0;
      continue;
    }
    column += 1;
  }
  return { line, column };
}
