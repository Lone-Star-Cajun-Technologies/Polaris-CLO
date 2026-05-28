import type { LedgerEvent } from "../loop/ledger.js";

const CLOSED_STATUSES = new Set(["complete", "finalized"]);

export interface RunsListOptions {
  open: boolean;
}

function latestEventsByRun(events: LedgerEvent[]): LedgerEvent[] {
  const latest = new Map<string, LedgerEvent>();
  for (const event of events) {
    latest.set(event.run_id, event);
  }
  return Array.from(latest.values()).sort((left, right) => left.run_id.localeCompare(right.run_id));
}

function formatRow(values: string[]): string {
  return values.join("\t");
}

export function runRunsList(events: LedgerEvent[], options: RunsListOptions): void {
  const rows = latestEventsByRun(events).filter(
    (event) => !options.open || !CLOSED_STATUSES.has(event.status),
  );

  const lines = [
    formatRow(["run_id", "run_type", "cluster_id", "branch", "status", "last event timestamp"]),
    ...rows.map((event) =>
      formatRow([
        event.run_id,
        event.run_type,
        event.cluster_id ?? "",
        event.branch,
        event.status,
        event.timestamp,
      ]),
    ),
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}
