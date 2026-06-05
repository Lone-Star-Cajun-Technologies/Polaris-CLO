/**
 * Tests for src/loop/worker-prompt.ts
 *
 * Covers:
 * - compact prompt generation (structure, required sections, governance)
 * - full mode: expanded issue context appended
 * - narrow-child detection via labels
 * - prompt mode selection
 * - oversized requirement compression (many requirements still produce one prompt)
 * - prompt metrics accuracy
 */

import { describe, expect, it } from "vitest";
import {
  buildWorkerPrompt,
  buildPromptFromPacketInput,
  isNarrowChild,
  selectPromptMode,
  type WorkerPromptInput,
} from "./worker-prompt.js";
import type { LoopState } from "./checkpoint.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(labels: string[] = []): LoopState {
  return {
    schema_version: "1.0",
    run_id: "test-run",
    cluster_id: "POL-130",
    skill: "polaris-run",
    artifact_dir: ".taskchain_artifacts/polaris-run",
    branch: "feat/test",
    current_step_id: "03-select-child",
    step_cursor: "dispatching",
    status: "running",
    session_type: "implementation",
    active_child: "POL-131",
    last_commit: "",
    pr_url: "",
    next_open_child: "POL-131",
    completed_children: [],
    open_children: ["POL-131"],
    open_children_meta: {
      "POL-131": {
        title: "IMPLEMENT: Add .smartdocignore parser",
        state: "Backlog",
        status_type: "backlog",
        blocked_by: [],
        labels,
      },
    },
    context_budget: { children_completed: 0, files_touched_total: 0, last_child_files_touched: 0 },
    validation_status: "not-run",
    updated_at: new Date().toISOString(),
    blocker: null,
  } as unknown as LoopState;
}

function makeBaseInput(overrides: Partial<WorkerPromptInput> = {}): WorkerPromptInput {
  return {
    issueId: "POL-131",
    title: "Add .smartdocignore parser",
    worktree: "/repo",
    branch: "feat/test",
    goal: "Parse .smartdocignore and enforce it during docs ingest.",
    scopeTouch: ["src/smartdocs-engine/ingest.ts", "src/smartdocs-engine/ignore-parser.ts"],
    scopeAvoid: ["src/loop/", "src/finalize/"],
    acceptanceCriteria: [
      "Parser reads .smartdocignore from repo root",
      "Ignored paths are skipped during ingest",
    ],
    existingHelpers: ["src/utils/glob.ts — glob matching utilities"],
    validationCommands: ["npm run build", "npm test"],
    commitFormat: "[POL-131] Add .smartdocignore parser",
    stateFile: ".taskchain_artifacts/polaris-run/current-state.json",
    telemetryFile: ".taskchain_artifacts/polaris-run/runs/test/telemetry.jsonl",
    mode: "compact",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildWorkerPrompt", () => {
  it("compact prompt contains required header fields", () => {
    const { prompt } = buildWorkerPrompt(makeBaseInput());
    expect(prompt).toContain("Issue: POL-131 — Add .smartdocignore parser");
    expect(prompt).toContain("Worktree: /repo");
    expect(prompt).toContain("Branch: feat/test");
  });

  it("compact prompt contains all required sections", () => {
    const { prompt } = buildWorkerPrompt(makeBaseInput());
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Scope");
    expect(prompt).toContain("## Acceptance Criteria");
    expect(prompt).toContain("## Existing Helpers");
    expect(prompt).toContain("## Validation");
    expect(prompt).toContain("## Commit");
    expect(prompt).toContain("## Governance");
    expect(prompt).toContain("## Report Back");
  });

  it("compact prompt contains governance instructions", () => {
    const { prompt } = buildWorkerPrompt(makeBaseInput());
    expect(prompt).toContain("Do NOT modify open_children or completed_children");
    expect(prompt).toContain("telemetry.jsonl");
    expect(prompt).toContain("TERMINATE SESSION IMMEDIATELY");
  });

  it("compact prompt contains report back fields", () => {
    const { prompt } = buildWorkerPrompt(makeBaseInput());
    expect(prompt).toContain("files changed");
    expect(prompt).toContain("validation results");
    expect(prompt).toContain("commit hash");
    expect(prompt).toContain("blockers");
  });

  it("compact prompt does NOT include expanded issue context section", () => {
    const { prompt } = buildWorkerPrompt(makeBaseInput());
    expect(prompt).not.toContain("## Expanded Issue Context");
    expect(prompt).not.toContain("---");
  });

  it("full mode appends expanded issue context", () => {
    const input = makeBaseInput({
      mode: "full",
      issueContext: {
        id: "POL-131",
        title: "Add .smartdocignore parser",
        key_requirements: ["Parse .smartdocignore", "Enforce during ingest"],
      },
    });
    const { prompt } = buildWorkerPrompt(input);
    expect(prompt).toContain("## Expanded Issue Context");
    expect(prompt).toContain("Parse .smartdocignore");
    expect(prompt).toContain("Enforce during ingest");
  });

  it("full mode without issueContext does not append expanded section", () => {
    const { prompt } = buildWorkerPrompt(makeBaseInput({ mode: "full" }));
    expect(prompt).not.toContain("## Expanded Issue Context");
  });

  it("compact prompt is smaller than full prompt with context", () => {
    const issueContext = {
      id: "POL-131",
      title: "Add .smartdocignore parser",
      key_requirements: Array.from({ length: 10 }, (_, i) => `Requirement ${i + 1}`),
    };
    const compact = buildWorkerPrompt(makeBaseInput({ mode: "compact", issueContext }));
    const full = buildWorkerPrompt(makeBaseInput({ mode: "full", issueContext }));
    expect(compact.metrics.char_count).toBeLessThan(full.metrics.char_count);
  });

  it("omits Existing Helpers section when list is empty", () => {
    const { prompt } = buildWorkerPrompt(makeBaseInput({ existingHelpers: [] }));
    expect(prompt).not.toContain("## Existing Helpers");
  });

  it("scope touch and avoid lines are included", () => {
    const { prompt } = buildWorkerPrompt(makeBaseInput());
    expect(prompt).toContain("src/smartdocs-engine/ingest.ts");
    expect(prompt).toContain("src/loop/");
  });

  it("metrics char_count matches prompt length", () => {
    const { prompt, metrics } = buildWorkerPrompt(makeBaseInput());
    expect(metrics.char_count).toBe(prompt.length);
  });

  it("metrics estimated_tokens is approximately char_count / 4", () => {
    const { prompt, metrics } = buildWorkerPrompt(makeBaseInput());
    expect(metrics.estimated_tokens).toBe(Math.round(prompt.length / 4));
  });

  it("many requirements still produce a single prompt (no truncation)", () => {
    const acceptanceCriteria = Array.from({ length: 20 }, (_, i) => `AC ${i + 1}`);
    const { prompt } = buildWorkerPrompt(makeBaseInput({ acceptanceCriteria }));
    for (let i = 1; i <= 20; i++) {
      expect(prompt).toContain(`AC ${i}`);
    }
  });
});

describe("isNarrowChild", () => {
  it("returns true when child has no labels", () => {
    expect(isNarrowChild("POL-131", makeState())).toBe(true);
  });

  it("returns true when child has irrelevant labels", () => {
    expect(isNarrowChild("POL-131", makeState(["implement", "docs"]))).toBe(true);
  });

  it("returns false for cross-cutting label", () => {
    expect(isNarrowChild("POL-131", makeState(["cross-cutting"]))).toBe(false);
  });

  it("returns false for high-risk label", () => {
    expect(isNarrowChild("POL-131", makeState(["high-risk"]))).toBe(false);
  });

  it("returns false for parallel label", () => {
    expect(isNarrowChild("POL-131", makeState(["parallel"]))).toBe(false);
  });

  it("returns false for worker-isolation label", () => {
    expect(isNarrowChild("POL-131", makeState(["worker-isolation"]))).toBe(false);
  });

  it("returns false for architectural label", () => {
    expect(isNarrowChild("POL-131", makeState(["architectural"]))).toBe(false);
  });

  it("returns true when child has no meta entry", () => {
    const state = makeState();
    expect(isNarrowChild("POL-999", state)).toBe(true);
  });
});

describe("selectPromptMode", () => {
  it("returns compact for narrow child with no override", () => {
    expect(selectPromptMode("POL-131", makeState())).toBe("compact");
  });

  it("returns full for non-narrow child", () => {
    expect(selectPromptMode("POL-131", makeState(["cross-cutting"]))).toBe("full");
  });

  it("override wins over narrow detection", () => {
    expect(selectPromptMode("POL-131", makeState(), "full")).toBe("full");
  });

  it("override wins over non-narrow detection", () => {
    expect(selectPromptMode("POL-131", makeState(["cross-cutting"]), "compact")).toBe("compact");
  });
});

describe("buildPromptFromPacketInput", () => {
  it("produces a prompt with the correct issue ID and title", () => {
    const { prompt } = buildPromptFromPacketInput({
      issueId: "POL-131",
      title: "Add .smartdocignore parser",
      worktree: ".",
      branch: "feat/test",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      mode: "compact",
    });
    expect(prompt).toContain("Issue: POL-131 — Add .smartdocignore parser");
  });

  it("uses first requirement as goal when issueContext provided without body", () => {
    const { prompt } = buildPromptFromPacketInput({
      issueId: "POL-131",
      title: "Add .smartdocignore parser",
      worktree: ".",
      branch: "feat/test",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      issueContext: {
        id: "POL-131",
        title: "Add .smartdocignore parser",
        key_requirements: ["Parse .smartdocignore from repo root", "Enforce during ingest"],
      },
      mode: "compact",
    });
    expect(prompt).toContain("Parse .smartdocignore from repo root");
  });

  it("uses body as the goal when body is present, overriding requirements", () => {
    const { prompt } = buildPromptFromPacketInput({
      issueId: "POL-131",
      title: "Add .smartdocignore parser",
      worktree: ".",
      branch: "feat/test",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      issueContext: {
        id: "POL-131",
        title: "Add .smartdocignore parser",
        key_requirements: ["Parse .smartdocignore from repo root"],
        body: "Parse the .smartdocignore file and use it to skip excluded paths during ingest.",
      },
      mode: "compact",
    });
    // Body must appear in the Goal section
    expect(prompt).toContain("Parse the .smartdocignore file and use it to skip excluded paths");
  });

  it("body appears in Expanded Issue Context in full mode", () => {
    const { prompt } = buildPromptFromPacketInput({
      issueId: "POL-131",
      title: "Add .smartdocignore parser",
      worktree: ".",
      branch: "feat/test",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      issueContext: {
        id: "POL-131",
        title: "Add .smartdocignore parser",
        key_requirements: [],
        body: "Parse the .smartdocignore file from the repo root.",
      },
      mode: "full",
    });
    expect(prompt).toContain("Expanded Issue Context");
    // Body should appear in the expanded section (in addition to the Goal section)
    const expandedIdx = prompt.indexOf("Expanded Issue Context");
    expect(prompt.slice(expandedIdx)).toContain("Parse the .smartdocignore file from the repo root.");
  });

  it("all requirements appear in Acceptance Criteria when body is present as goal", () => {
    // Regression: previously requirements.slice(1) discarded requirements[0] when body was goal.
    const { prompt } = buildPromptFromPacketInput({
      issueId: "POL-131",
      title: "Add parser",
      worktree: ".",
      branch: "feat/test",
      stateFile: "state.json",
      telemetryFile: "telemetry.jsonl",
      issueContext: {
        id: "POL-131",
        title: "Add parser",
        key_requirements: ["Req A", "Req B", "Req C"],
        body: "Full description here.",
      },
      mode: "compact",
    });
    expect(prompt).toContain("Full description here.");
    expect(prompt).toContain("Req A");
    expect(prompt).toContain("Req B");
    expect(prompt).toContain("Req C");
  });

  it("returns compact metrics by default for narrow input", () => {
    const { metrics } = buildPromptFromPacketInput({
      issueId: "POL-131",
      title: "Title",
      worktree: ".",
      branch: "main",
      stateFile: "s.json",
      telemetryFile: "t.jsonl",
      mode: "compact",
    });
    expect(metrics.mode).toBe("compact");
    expect(metrics.char_count).toBeGreaterThan(0);
    expect(metrics.estimated_tokens).toBeGreaterThan(0);
  });
});
