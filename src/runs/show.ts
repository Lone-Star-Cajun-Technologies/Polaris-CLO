import type { LedgerEvent } from "../loop/ledger.js";

export function runRunsShow(events: LedgerEvent[], runId: string): void {
  const lines = events
    .filter((event) => event.run_id === runId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .map((event) => JSON.stringify(event));

  process.stdout.write(lines.length > 0 ? `${lines.join("\n")}\n` : "");
}
