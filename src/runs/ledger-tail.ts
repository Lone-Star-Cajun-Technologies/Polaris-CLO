function parseLineCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 20;
  }
  return parsed;
}

export function runRunsLedgerTail(rawLines: string[], count: string): void {
  const lineCount = parseLineCount(count);
  const lines = rawLines.slice(-lineCount);
  process.stdout.write(lines.length > 0 ? `${lines.join("\n")}\n` : "");
}
