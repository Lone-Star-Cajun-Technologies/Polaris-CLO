/**
 * Tests for SOL history store (sol-history.ts).
 *
 * Coverage:
 *   - appendSnapshot: creates directory and file, appends JSONL lines
 *   - loadSnapshots: reads back persisted snapshots, tolerates missing file
 *   - buildSnapshot: constructs snapshot from report + metadata
 *   - Append-only: successive appends don't overwrite earlier entries
 *   - getHistoryFilePath: deterministic path generation
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendSnapshot,
  loadSnapshots,
  buildSnapshot,
  getHistoryFilePath,
} from "./sol-history.js";
import type { SolScoreSnapshot } from "./sol-history.js";
import type { SolScoreReport } from "../types/sol-score.js";

// ── Helpers ──

function makeDimScore(dimension: string, score: number | null) {
  return {
    dimension,
    score,
    confidence: "high" as const,
  };
}

function makeReport(runId: string, compositeScore: number | null = 0.85): SolScoreReport {
  const dim = (name: string) => makeDimScore(name, compositeScore);
  return {
    run_id: runId,
    cluster_id: "POL-100",
    scored_at: new Date().toISOString(),
    foreman: {
      composite_score: compositeScore,
      composite_confidence: "high",
      token: dim("token"),
      duration: dim("duration"),
      intervention: dim("intervention"),
      pre_analysis: dim("pre_analysis"),
      dependency: dim("dependency"),
      dispatch: dim("dispatch"),
      evidence_validation: dim("evidence_validation"),
      scope: dim("scope"),
      completion: dim("completion"),
      recovery: dim("recovery"),
    },
    workers: {},
    run_composite_score: compositeScore,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sol-history-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("getHistoryFilePath", () => {
  it("returns deterministic default path", () => {
    const path = getHistoryFilePath("/repo");
    expect(path).toBe("/repo/.polaris/sol-history/scores.jsonl");
  });

  it("respects custom path", () => {
    const path = getHistoryFilePath("/repo", "custom/history");
    expect(path).toBe("/repo/custom/history/scores.jsonl");
  });
});

describe("buildSnapshot", () => {
  it("constructs a valid snapshot from report and metadata", () => {
    const report = makeReport("run-1");
    const snapshot = buildSnapshot(report, { provider: "devin", role: "worker" }, ["w-1", "w-2"]);

    expect(snapshot.schema_version).toBe("1.0");
    expect(snapshot.report.run_id).toBe("run-1");
    expect(snapshot.grouping_keys.provider).toBe("devin");
    expect(snapshot.worker_ids).toEqual(["w-1", "w-2"]);
  });
});

describe("appendSnapshot", () => {
  it("creates directory and file when they don't exist", () => {
    const report = makeReport("run-1");
    const snapshot = buildSnapshot(report, {}, []);
    const path = appendSnapshot(tempDir, snapshot);

    expect(existsSync(path)).toBe(true);
  });

  it("writes one JSONL line per snapshot", () => {
    const s1 = buildSnapshot(makeReport("run-1"), {}, []);
    const s2 = buildSnapshot(makeReport("run-2"), {}, []);

    appendSnapshot(tempDir, s1);
    appendSnapshot(tempDir, s2);

    const content = readFileSync(getHistoryFilePath(tempDir), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
  });

  it("preserves earlier entries when appending (append-only)", () => {
    const s1 = buildSnapshot(makeReport("run-1"), {}, []);
    appendSnapshot(tempDir, s1);
    const contentBefore = readFileSync(getHistoryFilePath(tempDir), "utf-8");

    const s2 = buildSnapshot(makeReport("run-2"), {}, []);
    appendSnapshot(tempDir, s2);
    const contentAfter = readFileSync(getHistoryFilePath(tempDir), "utf-8");

    expect(contentAfter.startsWith(contentBefore)).toBe(true);
  });

  it("respects custom history path", () => {
    const s = buildSnapshot(makeReport("run-1"), {}, []);
    const path = appendSnapshot(tempDir, s, "custom-dir");

    expect(path).toContain("custom-dir");
    expect(existsSync(path)).toBe(true);
  });
});

describe("loadSnapshots", () => {
  it("returns empty array when file doesn't exist", () => {
    const snapshots = loadSnapshots(tempDir);
    expect(snapshots).toEqual([]);
  });

  it("round-trips snapshots through write and read", () => {
    const s1 = buildSnapshot(makeReport("run-1", 0.9), { provider: "devin" }, ["w-1"]);
    const s2 = buildSnapshot(makeReport("run-2", 0.75), { provider: "claude" }, ["w-2"]);

    appendSnapshot(tempDir, s1);
    appendSnapshot(tempDir, s2);

    const loaded = loadSnapshots(tempDir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].report.run_id).toBe("run-1");
    expect(loaded[0].grouping_keys.provider).toBe("devin");
    expect(loaded[1].report.run_id).toBe("run-2");
    expect(loaded[1].report.run_composite_score).toBe(0.75);
  });

  it("tolerates malformed lines in the history file", () => {
    const s = buildSnapshot(makeReport("run-1"), {}, []);
    appendSnapshot(tempDir, s);

    // Manually append a bad line
    const path = getHistoryFilePath(tempDir);
    const { appendFileSync } = require("node:fs");
    appendFileSync(path, "not-valid-json\n", "utf-8");

    const loaded = loadSnapshots(tempDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].report.run_id).toBe("run-1");
  });
});
