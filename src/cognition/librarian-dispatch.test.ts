import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecutionAdapter } from "../loop/adapters/types.js";
import { dispatchCognitionLibrarian, validateAndApplyLibrarianResult } from "./librarian-dispatch.js";
import type {
  CognitionLibrarianPacket,
  CognitionLibrarianResult,
  CognitionPatch,
} from "./librarian-types.js";
import { SUMMARY_MAX_BYTES } from "./summary-delta.js";

function makeTmp(): string {
  const dir = join(tmpdir(), `polaris-librarian-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function makePacket(
  overrides?: Partial<CognitionLibrarianPacket>,
): CognitionLibrarianPacket {
  return {
    run_id: "test-run-001",
    dispatch_id: "dispatch-001",
    role: "cognition-librarian",
    folder: "src/loop/",
    folder_slug: "src-loop",
    note_paths: [".polaris/cognition/pending/src-loop/note.md"],
    polaris_md_path: "src/loop/POLARIS.md",
    summary_md_path: "src/loop/SUMMARY.md",
    cognition_index_path: ".polaris/cognition/archive/src-loop/cognition-index.json",
    result_path: "/tmp/result.json",
    constraints: {
      max_polaris_addition_lines: 20,
      max_summary_addition_lines: 30,
      require_confidence_threshold: 0.80,
      allowed_files: ["src/loop/POLARIS.md", "src/loop/SUMMARY.md"],
    },
    ...overrides,
  };
}

function makeResult(
  overrides?: Partial<CognitionLibrarianResult>,
): CognitionLibrarianResult {
  return {
    run_id: "test-run-001",
    dispatch_id: "dispatch-001",
    role: "cognition-librarian",
    folder: "src/loop/",
    folder_slug: "src-loop",
    notes_reconciled: [".polaris/cognition/pending/src-loop/note.md"],
    confidence: 0.90,
    proposed_patches: [],
    archive_actions: [],
    status: "success",
    ...overrides,
  };
}

function makePatch(overrides?: Partial<CognitionPatch>): CognitionPatch {
  return {
    file: "src/loop/POLARIS.md",
    action: "update",
    proposed_content: "# POLARIS\n\nShort update.",
    change_summary: "minor update",
    ...overrides,
  };
}

describe("validateAndApplyLibrarianResult", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  // ── No-patch / success cases ─────────────────────────────────────────────

  it("approves a valid result with no patches (no-change)", () => {
    const outcome = validateAndApplyLibrarianResult(
      makeResult({ status: "no-change" }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(true);
    expect(outcome.files_written).toEqual([]);
    expect(outcome.patches_applied).toEqual([]);
    expect(outcome.patches_rejected).toEqual([]);
  });

  it("writes valid POLARIS.md patch to disk", () => {
    const content = "# POLARIS\n\nNew content.";
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        confidence: 0.95,
        proposed_patches: [makePatch({ proposed_content: content })],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(true);
    expect(outcome.patches_applied).toHaveLength(1);
    expect(outcome.files_written).toEqual(["src/loop/POLARIS.md"]);
    expect(readFileSync(join(tmp, "src/loop/POLARIS.md"), "utf-8")).toBe(content);
  });

  it("approves at exactly the confidence threshold boundary", () => {
    const outcome = validateAndApplyLibrarianResult(
      makeResult({ confidence: 0.80 }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(true);
  });

  // ── Schema validation (rejects entire result) ───────────────────────────

  it("rejects result with invalid schema: missing run_id", () => {
    const outcome = validateAndApplyLibrarianResult(
      makeResult({ run_id: "" }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(false);
    expect(outcome.rejection_reason).toMatch(/SCHEMA_INVALID/);
    expect(outcome.files_written).toEqual([]);
  });

  it("rejects result with invalid schema: wrong role", () => {
    const result = makeResult();
    const bad = { ...result, role: "worker" } as unknown as CognitionLibrarianResult;
    const outcome = validateAndApplyLibrarianResult(bad, tmp, makePacket());
    expect(outcome.approved).toBe(false);
    expect(outcome.rejection_reason).toMatch(/SCHEMA_INVALID/);
  });

  it("rejects result with invalid schema: confidence out of range", () => {
    const outcome = validateAndApplyLibrarianResult(
      makeResult({ confidence: 1.5 }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(false);
    expect(outcome.rejection_reason).toMatch(/SCHEMA_INVALID/);
  });

  // ── Confidence threshold §6.4 (rejects entire result) ──────────────────

  it("rejects result below confidence threshold", () => {
    const outcome = validateAndApplyLibrarianResult(
      makeResult({ confidence: 0.50 }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(false);
    expect(outcome.rejection_reason).toMatch(/COGNITION_LOW_CONFIDENCE/);
    expect(outcome.rejection_reason).toMatch(/0\.5/);
    expect(outcome.files_written).toEqual([]);
  });

  it("rejects result just below confidence threshold (0.799)", () => {
    const outcome = validateAndApplyLibrarianResult(
      makeResult({ confidence: 0.799 }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(false);
    expect(outcome.rejection_reason).toMatch(/COGNITION_LOW_CONFIDENCE/);
  });

  // ── File scope check §6.1 (rejects entire result) ───────────────────────

  it("rejects entire result when any patch targets an out-of-scope file", () => {
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [
          makePatch({ file: "src/other/POLARIS.md" }),
        ],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(false);
    expect(outcome.rejection_reason).toMatch(/COGNITION_SCOPE_VIOLATION/);
    expect(outcome.rejection_reason).toMatch(/src\/other\/POLARIS\.md/);
    expect(outcome.files_written).toEqual([]);
  });

  it("rejects entire result when second patch is out-of-scope, even if first is valid", () => {
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [
          makePatch({ file: "src/loop/POLARIS.md" }),
          makePatch({ file: "src/other/POLARIS.md" }),
        ],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(false);
    expect(outcome.rejection_reason).toMatch(/COGNITION_SCOPE_VIOLATION/);
    // No files written — entire result rejected
    expect(outcome.files_written).toEqual([]);
    expect(existsSync(join(tmp, "src/loop/POLARIS.md"))).toBe(false);
  });

  // ── Doctrine bleed §6.2 (rejects specific patch, not entire result) ────

  it("rejects SUMMARY.md patch containing doctrine bleed patterns", () => {
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [
          makePatch({
            file: "src/loop/SUMMARY.md",
            proposed_content: "## Editing Rules\nDo not do X.",
          }),
        ],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.patches_rejected).toHaveLength(1);
    expect(outcome.patches_rejected[0]!.reason).toMatch(/COGNITION_DOCTRINE_BLEED/);
    expect(outcome.files_written).toEqual([]);
  });

  it("rejects doctrine-bleeding SUMMARY.md patch but applies valid POLARIS.md patch", () => {
    const polarisContent = "# Loop\n\nUpdated.";
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [
          makePatch({ file: "src/loop/POLARIS.md", proposed_content: polarisContent }),
          makePatch({
            file: "src/loop/SUMMARY.md",
            proposed_content: "## Constraints\nMust always use X.",
          }),
        ],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(true);
    expect(outcome.patches_applied).toHaveLength(1);
    expect(outcome.patches_rejected).toHaveLength(1);
    expect(outcome.patches_rejected[0]!.reason).toMatch(/COGNITION_DOCTRINE_BLEED/);
    expect(outcome.files_written).toEqual(["src/loop/POLARIS.md"]);
    expect(readFileSync(join(tmp, "src/loop/POLARIS.md"), "utf-8")).toBe(polarisContent);
  });

  it("does not apply doctrine-bleed check to POLARIS.md patches", () => {
    // POLARIS.md can contain constraint-like language — only SUMMARY.md is checked
    const content = "## Constraints\nMust always do X.";
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [makePatch({ proposed_content: content })],
      }),
      tmp,
      makePacket(),
    );
    // POLARIS.md lines check: "## Constraints\nMust always do X." = 2 lines ≤ 20
    expect(outcome.patches_rejected).toHaveLength(0);
    expect(outcome.patches_applied).toHaveLength(1);
  });

  // ── Size guard §6.3 (rejects specific patch, not entire result) ─────────

  it("rejects POLARIS.md patch exceeding max_polaris_addition_lines", () => {
    const lines = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n");
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [makePatch({ proposed_content: lines })],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.patches_rejected).toHaveLength(1);
    expect(outcome.patches_rejected[0]!.reason).toMatch(/COGNITION_SIZE_GUARD/);
    expect(outcome.patches_rejected[0]!.reason).toMatch(/21 lines/);
  });

  it("accepts POLARIS.md patch at exactly the line limit", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [makePatch({ proposed_content: lines })],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.patches_rejected).toHaveLength(0);
    expect(outcome.patches_applied).toHaveLength(1);
  });

  it("rejects SUMMARY.md patch exceeding SUMMARY_MAX_BYTES", () => {
    const content = "x".repeat(SUMMARY_MAX_BYTES + 1);
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [
          makePatch({ file: "src/loop/SUMMARY.md", proposed_content: content }),
        ],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.patches_rejected).toHaveLength(1);
    expect(outcome.patches_rejected[0]!.reason).toMatch(/COGNITION_SIZE_GUARD/);
    expect(outcome.files_written).toEqual([]);
  });

  it("accepts SUMMARY.md patch just under SUMMARY_MAX_BYTES", () => {
    const content = "x".repeat(SUMMARY_MAX_BYTES - 1);
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [
          makePatch({ file: "src/loop/SUMMARY.md", proposed_content: content }),
        ],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.patches_rejected).toHaveLength(0);
    expect(outcome.patches_applied).toHaveLength(1);
  });

  // ── All-rejected edge case ───────────────────────────────────────────────

  it("returns approved: false when all patches are rejected at patch level", () => {
    const oversized = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n");
    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [makePatch({ proposed_content: oversized })],
      }),
      tmp,
      makePacket(),
    );
    expect(outcome.approved).toBe(false);
    expect(outcome.rejection_reason).toBe("all patches rejected");
    expect(outcome.files_written).toEqual([]);
    expect(existsSync(join(tmp, "src/loop/POLARIS.md"))).toBe(false);
  });

  it("rejects patch targeting a protected user-created cognition surface", () => {
    mkdirSync(join(tmp, ".polaris", "cognition"), { recursive: true });
    writeFileSync(
      join(tmp, ".polaris", "cognition", "managed-surfaces.json"),
      JSON.stringify({ surfaces: ["src/loop/POLARIS.md"] }),
      "utf-8",
    );
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "POLARIS.md"), "# Human-authored", "utf-8");

    const outcome = validateAndApplyLibrarianResult(
      makeResult({
        proposed_patches: [
          makePatch({ file: "src/loop/POLARIS.md", proposed_content: "# Bot overwrite" }),
        ],
      }),
      tmp,
      makePacket(),
    );

    expect(outcome.approved).toBe(false);
    expect(outcome.patches_applied).toHaveLength(0);
    expect(outcome.patches_rejected).toHaveLength(1);
    expect(outcome.patches_rejected[0]!.reason).toMatch(/COGNITION_USER_SURFACE_PROTECTED/);
    expect(readFileSync(join(tmp, "src", "loop", "POLARIS.md"), "utf-8")).toBe("# Human-authored");
  });
});

describe("dispatchCognitionLibrarian telemetry", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it("emits cognition-user-surface-protected when protected patch is rejected", async () => {
    mkdirSync(join(tmp, ".polaris", "cognition", "pending", "src-loop"), { recursive: true });
    mkdirSync(join(tmp, ".polaris", "cognition"), { recursive: true });
    writeFileSync(
      join(tmp, ".polaris", "cognition", "managed-surfaces.json"),
      JSON.stringify({ surfaces: ["src/loop/POLARIS.md"] }),
      "utf-8",
    );
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "POLARIS.md"), "# Existing user content", "utf-8");

    const notePath = ".polaris/cognition/pending/src-loop/note.md";
    writeFileSync(
      join(tmp, notePath),
      [
        "---",
        "folder: src/loop",
        "folder_slug: src-loop",
        "docs_impact: polaris",
        "---",
        "",
        "note",
      ].join("\n"),
      "utf-8",
    );
    const telemetryFile = join(tmp, "telemetry.jsonl");
    writeFileSync(telemetryFile, "", "utf-8");

    const adapter: ExecutionAdapter = {
      name: "mock",
      async dispatch(packet): Promise<{ exit_code: number; provider_used: string; command_run: string }> {
        const statePath = String(packet.state_file);
        const librarianPacket = JSON.parse(readFileSync(statePath, "utf-8")) as CognitionLibrarianPacket;
        const result: CognitionLibrarianResult = makeResult({
          run_id: librarianPacket.run_id,
          dispatch_id: librarianPacket.dispatch_id,
          folder: librarianPacket.folder,
          folder_slug: librarianPacket.folder_slug,
          proposed_patches: [
            makePatch({
              file: "src/loop/POLARIS.md",
              proposed_content: "# Bot content",
            }),
          ],
        });
        writeFileSync(librarianPacket.result_path, JSON.stringify(result), "utf-8");
        return { exit_code: 0, provider_used: "mock", command_run: "mock" };
      },
    };

    await dispatchCognitionLibrarian({
      runId: "run-telemetry-1",
      clusterId: "POL-999",
      workNotePaths: [notePath],
      repoRoot: tmp,
      adapter,
      provider: "mock",
      telemetryFile,
      timeoutMs: 5000,
    });

    const events = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const protectedEvent = events.find((event) => event["event"] === "cognition-user-surface-protected");
    expect(protectedEvent).toBeDefined();
    expect(protectedEvent?.["file"]).toBe("src/loop/POLARIS.md");
    expect(protectedEvent?.["folder_slug"]).toBe("src-loop");
    expect(readFileSync(join(tmp, "src", "loop", "POLARIS.md"), "utf-8")).toBe("# Existing user content");
  });
});
