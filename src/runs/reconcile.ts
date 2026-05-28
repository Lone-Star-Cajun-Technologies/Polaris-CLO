import { existsSync, readFileSync } from "node:fs";
import type { LedgerEvent } from "../loop/ledger.js";

export interface RunsReconcileOptions {
  repoRoot: string;
  stateFile: string;
}

interface CurrentState {
  run_id?: string;
  cluster_id?: string;
  branch?: string;
  status?: string;
  completed_children?: string[];
  open_children?: string[];
  next_open_child?: string | null;
  last_commit?: string | null;
}

interface Divergence {
  field: string;
  ledger: unknown;
  current_state: unknown;
}

function latestEventForRun(events: LedgerEvent[], runId: string): LedgerEvent | null {
  return events.filter((event) => event.run_id === runId).at(-1) ?? null;
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function collectDivergences(ledger: LedgerEvent, state: CurrentState): Divergence[] {
  const divergences: Divergence[] = [];
  const scalarChecks: Array<[string, unknown, unknown]> = [
    ["cluster_id", ledger.cluster_id, state.cluster_id],
    ["branch", ledger.branch, state.branch],
    ["status", ledger.status, state.status],
    ["next_child", ledger.next_child, state.next_open_child ?? null],
    ["last_commit", ledger.last_commit, state.last_commit ?? null],
  ];

  for (const [field, ledgerValue, stateValue] of scalarChecks) {
    if (ledgerValue !== stateValue) {
      divergences.push({ field, ledger: ledgerValue, current_state: stateValue });
    }
  }

  if (!sameStringArray(ledger.completed_children, state.completed_children)) {
    divergences.push({
      field: "completed_children",
      ledger: ledger.completed_children,
      current_state: state.completed_children ?? [],
    });
  }

  if (!sameStringArray(ledger.open_children, state.open_children)) {
    divergences.push({
      field: "open_children",
      ledger: ledger.open_children,
      current_state: state.open_children ?? [],
    });
  }

  return divergences;
}

export function runRunsReconcile(events: LedgerEvent[], options: RunsReconcileOptions): void {
  if (!existsSync(options.stateFile)) {
    process.stdout.write(`read-only: no current-state.json found at ${options.stateFile}\n`);
    return;
  }

  let state: CurrentState;
  try {
    state = JSON.parse(readFileSync(options.stateFile, "utf-8")) as CurrentState;
  } catch (err) {
    process.stdout.write("read-only: current-state.json has no run_id\n");
    return;
  }

  if (!state.run_id) {
    process.stdout.write("read-only: current-state.json has no run_id\n");
    return;
  }

  const latest = latestEventForRun(events, state.run_id);
  if (!latest) {
    process.stdout.write(`read-only: divergence found\nrun_id\tledger\tcurrent_state\n${state.run_id}\tmissing\tpresent\n`);
    return;
  }

  const divergences = collectDivergences(latest, state);
  if (divergences.length === 0) {
    process.stdout.write("read-only: no divergence found\n");
    return;
  }

  const lines = [
    "read-only: divergence found",
    "field\tledger\tcurrent_state",
    ...divergences.map(
      (divergence) =>
        `${divergence.field}\t${JSON.stringify(divergence.ledger)}\t${JSON.stringify(divergence.current_state)}`,
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
