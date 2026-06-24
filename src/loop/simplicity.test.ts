import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runSimplicityCommand } from "./simplicity.js";

function makeTempStateFile(overrides: Record<string, unknown> = {}): string {
  const dir = join(tmpdir(), `polaris-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, "current-state.json");
  const state: Record<string, unknown> = {
    schema_version: "1.0",
    run_id: "run-test",
    cluster_id: "POL-100",
    status: "running",
    active_child: "",
    completed_children: [],
    open_children: [],
    step_cursor: null,
    next_open_child: null,
    context_budget: { children_completed: 0 },
    ...overrides,
  };
  writeFileSync(stateFile, JSON.stringify(state), "utf-8");
  return stateFile;
}

describe("runSimplicityCommand", () => {
  it("--bypass sets simplicity_bypass: true in state", () => {
    const stateFile = makeTempStateFile();
    runSimplicityCommand({ bypass: true, restore: false, stateFile });
    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(state.simplicity_bypass).toBe(true);
  });

  it("--restore sets simplicity_bypass: false in state", () => {
    const stateFile = makeTempStateFile({ simplicity_bypass: true });
    runSimplicityCommand({ bypass: false, restore: true, stateFile });
    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(state.simplicity_bypass).toBe(false);
  });

  it("bare call (no flags) does not mutate state", () => {
    const stateFile = makeTempStateFile({ simplicity_bypass: true });
    const before = readFileSync(stateFile, "utf-8");
    runSimplicityCommand({ bypass: false, restore: false, stateFile });
    const after = readFileSync(stateFile, "utf-8");
    expect(after).toBe(before);
  });

  it("throws when state file is missing and bypass is requested", () => {
    expect(() =>
      runSimplicityCommand({ bypass: true, restore: false, stateFile: "/no/such/file.json" })
    ).toThrow();
  });
});
