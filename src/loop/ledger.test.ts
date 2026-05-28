import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LEDGER_PATH, LedgerWriter, type LedgerEvent } from "./ledger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "polaris-ledger-"));
  tempDirs.push(dir);
  return dir;
}

function ledgerPath(): string {
  return join(makeTempDir(), "nested", "ledger.jsonl");
}

function event(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    schema_version: 1,
    event_id: `event-${Math.random().toString(36).slice(2)}`,
    event: "run-started",
    run_id: "run-1",
    run_type: "implement",
    cluster_id: "POL-151",
    issue_id: "POL-153",
    branch: "feature/pol-151",
    status: "running",
    completed_children: [],
    open_children: ["POL-153"],
    next_child: "POL-153",
    last_commit: null,
    pr_url: null,
    timestamp: "2026-05-28T03:16:13.194Z",
    ...overrides,
  } as LedgerEvent;
}

describe("LedgerWriter", () => {
  it("defaults to the global Polaris ledger path", () => {
    expect(DEFAULT_LEDGER_PATH).toBe(".polaris/runs/ledger.jsonl");
  });

  it("appends one JSONL line to the configured ledger file", () => {
    const path = ledgerPath();
    const writer = new LedgerWriter(path);
    const entry = event();

    writer.append(entry);

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]) as LedgerEvent).toEqual(entry);
  });

  it("readAll parses all ledger events", () => {
    const writer = new LedgerWriter(ledgerPath());
    const first = event({ event_id: "1", run_id: "run-1" });
    const second = event({ event_id: "2", run_id: "run-2", cluster_id: "POL-200" });

    writer.append(first);
    writer.append(second);

    expect(writer.readAll()).toEqual([first, second]);
  });

  it("queryByIssue returns events for a matching cluster_id", () => {
    const writer = new LedgerWriter(ledgerPath());
    const matching = event({ event_id: "1", cluster_id: "POL-151" });
    const other = event({ event_id: "2", cluster_id: "POL-200" });

    writer.append(matching);
    writer.append(other);

    expect(writer.queryByIssue("POL-151")).toEqual([matching]);
  });

  it("queryOpenRuns returns the latest event per run_id when status is not complete or finalized", () => {
    const writer = new LedgerWriter(ledgerPath());
    const staleOpen = event({ event_id: "1", run_id: "run-open", status: "running" });
    const latestOpen = event({
      event_id: "2",
      event: "run-paused",
      run_id: "run-open",
      status: "paused",
      pause_reason: "handoff",
    });
    const complete = event({
      event_id: "3",
      event: "run-complete",
      run_id: "run-complete",
      status: "complete",
      open_children: [],
      next_child: null,
    });
    const finalized = event({
      event_id: "4",
      event: "finalized",
      run_id: "run-finalized",
      status: "finalized",
      finalize_result: { ok: true },
    });

    writer.append(staleOpen);
    writer.append(latestOpen);
    writer.append(complete);
    writer.append(finalized);

    expect(writer.queryOpenRuns()).toEqual([latestOpen]);
  });

  it("returns empty arrays when the ledger file does not exist", () => {
    const writer = new LedgerWriter(ledgerPath());

    expect(writer.readAll()).toEqual([]);
    expect(writer.queryByIssue("POL-151")).toEqual([]);
    expect(writer.queryOpenRuns()).toEqual([]);
  });

  it("keeps concurrent appends as complete JSONL lines without lost events", async () => {
    const path = ledgerPath();
    const writers = Array.from({ length: 25 }, () => new LedgerWriter(path));
    const entries = writers.map((_, index) =>
      event({
        event_id: `event-${index}`,
        run_id: `run-${index}`,
        cluster_id: index % 2 === 0 ? "POL-151" : "POL-200",
      }),
    );

    await Promise.all(
      entries.map(
        (entry, index) =>
          new Promise<void>((resolve) => {
            setImmediate(() => {
              writers[index].append(entry);
              resolve();
            });
          }),
      ),
    );

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const parsed = lines.map((line) => JSON.parse(line) as LedgerEvent);
    expect(parsed).toHaveLength(entries.length);
    expect(new Set(parsed.map((entry) => entry.event_id))).toEqual(
      new Set(entries.map((entry) => entry.event_id)),
    );
  });
});
