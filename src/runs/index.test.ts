import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolarisCommand } from "../cli/index.js";
import type { LedgerEvent } from "../loop/ledger.js";

const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

afterEach(() => {
  stdout.mockClear();
  stderr.mockClear();
});

function repoWithLedger(events?: LedgerEvent[]): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "polaris-runs-"));
  if (events) {
    const ledgerDir = join(repoRoot, ".polaris", "runs");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      join(ledgerDir, "ledger.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
  }
  return repoRoot;
}

function event(overrides: Partial<LedgerEvent>): LedgerEvent {
  return {
    schema_version: 1,
    event_id: overrides.event_id ?? "event-1",
    event: overrides.event ?? "run-started",
    run_id: overrides.run_id ?? "run-1",
    run_type: overrides.run_type ?? "implement",
    cluster_id: overrides.cluster_id ?? "POL-1",
    issue_id: overrides.issue_id ?? null,
    branch: overrides.branch ?? "feature/run-1",
    status: overrides.status ?? "running",
    completed_children: overrides.completed_children ?? [],
    open_children: overrides.open_children ?? [],
    next_child: overrides.next_child ?? null,
    last_commit: overrides.last_commit ?? null,
    pr_url: overrides.pr_url ?? null,
    timestamp: overrides.timestamp ?? "2026-05-28T00:00:00.000Z",
    ...overrides,
  } as LedgerEvent;
}

async function run(args: string[], repoRoot: string): Promise<{ exitCode: number; output: string }> {
  const program = createPolarisCommand({ repoRoot });
  let exitCode = 0;
  program.exitOverride();

  try {
    await program.parseAsync(["node", "polaris", ...args], { from: "node" });
  } catch (error) {
    if (error instanceof Error && "exitCode" in error) {
      exitCode = Number(error.exitCode);
    } else {
      throw error;
    }
  }

  return {
    exitCode,
    output: stdout.mock.calls.map((call) => String(call[0])).join(""),
  };
}

describe("polaris runs", () => {
  it("lists the latest row for each run with required columns", async () => {
    const repoRoot = repoWithLedger([
      event({ run_id: "run-a", event_id: "a-1", status: "running" }),
      event({
        run_id: "run-a",
        event_id: "a-2",
        status: "cluster-complete",
        timestamp: "2026-05-28T00:05:00.000Z",
      }),
      event({
        run_id: "run-b",
        event_id: "b-1",
        run_type: "analyze",
        cluster_id: "POL-2",
        branch: "feature/run-2",
        status: "finalized",
        timestamp: "2026-05-28T00:07:00.000Z",
      }),
    ]);

    const result = await run(["runs", "list"], repoRoot);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("run_id");
    expect(result.output).toContain("run_type");
    expect(result.output).toContain("cluster_id");
    expect(result.output).toContain("branch");
    expect(result.output).toContain("status");
    expect(result.output).toContain("last event timestamp");
    expect(result.output).toContain("run-a");
    expect(result.output).toContain("cluster-complete");
    expect(result.output).toContain("run-b");
    expect(result.output).toContain("finalized");
  });

  it("filters list --open to runs not complete or finalized", async () => {
    const repoRoot = repoWithLedger([
      event({ run_id: "open-run", status: "running" }),
      event({ run_id: "complete-run", status: "complete" }),
      event({ run_id: "finalized-run", status: "finalized" }),
    ]);

    const result = await run(["runs", "list", "--open"], repoRoot);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("open-run");
    expect(result.output).not.toContain("complete-run");
    expect(result.output).not.toContain("finalized-run");
  });

  it("shows events for a run in chronological order", async () => {
    const repoRoot = repoWithLedger([
      event({
        run_id: "run-a",
        event_id: "late",
        event: "child-completed",
        timestamp: "2026-05-28T00:05:00.000Z",
        issue_id: "POL-2",
        last_commit: "abc123",
        validation: { status: "passed" },
      }),
      event({
        run_id: "run-a",
        event_id: "early",
        event: "run-started",
        timestamp: "2026-05-28T00:01:00.000Z",
      }),
      event({ run_id: "run-b", event_id: "other" }),
    ]);

    const result = await run(["runs", "show", "run-a"], repoRoot);

    expect(result.exitCode).toBe(0);
    expect(result.output.indexOf('"event_id":"early"')).toBeLessThan(
      result.output.indexOf('"event_id":"late"'),
    );
    expect(result.output).not.toContain('"event_id":"other"');
  });

  it("tails the last N raw ledger lines", async () => {
    const repoRoot = repoWithLedger([
      event({ event_id: "one" }),
      event({ event_id: "two" }),
      event({ event_id: "three" }),
    ]);

    const result = await run(["runs", "ledger", "tail", "--n", "2"], repoRoot);

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('"event_id":"one"');
    expect(result.output).toContain('"event_id":"two"');
    expect(result.output).toContain('"event_id":"three"');
  });

  it("reports reconcile divergence without mutating state", async () => {
    const repoRoot = repoWithLedger([
      event({
        run_id: "run-a",
        cluster_id: "POL-1",
        branch: "feature/ledger",
        status: "running",
        completed_children: [],
        open_children: ["POL-2"],
        next_child: "POL-2",
        last_commit: "ledger-commit",
      }),
    ]);
    const statePath = join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
    mkdirSync(join(repoRoot, ".taskchain_artifacts", "polaris-run"), { recursive: true });
    const state = {
      run_id: "run-a",
      cluster_id: "POL-1",
      branch: "feature/state",
      status: "running",
      completed_children: ["POL-1"],
      open_children: [],
      next_open_child: null,
      last_commit: "state-commit",
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const result = await run(["runs", "reconcile"], repoRoot);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("divergence");
    expect(result.output).toContain("branch");
    expect(result.output).toContain("completed_children");
    expect(result.output).toContain("read-only");
    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual(state);
  });

  it("exits cleanly when the ledger is absent", async () => {
    const repoRoot = repoWithLedger();

    const result = await run(["runs", "list"], repoRoot);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("no ledger found");
  });
});
