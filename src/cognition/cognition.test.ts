/**
 * Tests for route-local cognition delta logic.
 *
 * Covers:
 * - isCognitionSkippedFolder
 * - detectOperationalReasons
 * - findNearestRoutePolarismd
 * - applyRouteCognitionDelta
 * - detectSummaryReasons
 * - applySummaryDelta
 * - isSummaryOversized / hasDoctrineBled
 * - validateCognitionSurfaces / validateSummaryFile
 * - looksLikePolarisChurn
 * - detectMissingCognitionSurfaces (map/update)
 * - seedCognitionDrafts (map/update)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isCognitionSkippedFolder,
  isPolarisOwnedFolder,
  isUserCreatedCognitionSurface,
  detectOperationalReasons,
  findNearestRoutePolarismd,
  applyRouteCognitionDelta,
} from "./route-cognition-delta.js";

import {
  detectSummaryReasons,
  applySummaryDelta,
  detectPrecedenceLevel,
  isSummaryOversized,
  hasDoctrineBled,
  SUMMARY_MAX_BYTES,
  findNearestSummarymd,
  detectMissingSummaries,
} from "./summary-delta.js";

import {
  validateCognitionSurfaces,
  validateSummaryFile,
  looksLikePolarisChurn,
} from "./validate.js";
import { archiveCognitionNotes } from "./archive.js";

import {
  detectMissingCognitionSurfaces,
  seedCognitionDrafts,
} from "../map/update.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmp(): string {
  const dir = join(tmpdir(), `polaris-cognition-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── isCognitionSkippedFolder ──────────────────────────────────────────────────

describe("isCognitionSkippedFolder", () => {
  it("skips .git", () => expect(isCognitionSkippedFolder(".git")).toBe(true));
  it("skips .git/ prefix", () => expect(isCognitionSkippedFolder(".git/refs")).toBe(true));
  it("skips node_modules", () => expect(isCognitionSkippedFolder("node_modules")).toBe(true));
  it("skips dist/", () => expect(isCognitionSkippedFolder("dist/index.js")).toBe(true));
  it("skips .taskchain_artifacts/", () => expect(isCognitionSkippedFolder(".taskchain_artifacts/polaris-run")).toBe(true));
  it("allows .polaris root", () => expect(isCognitionSkippedFolder(".polaris")).toBe(false));
  it("allows .polaris/bootstrap", () => expect(isCognitionSkippedFolder(".polaris/bootstrap")).toBe(false));
  it("allows .polaris/clusters", () => expect(isCognitionSkippedFolder(".polaris/clusters")).toBe(false));
  it("allows .polaris/map", () => expect(isCognitionSkippedFolder(".polaris/map")).toBe(false));
  it("allows .polaris/runs", () => expect(isCognitionSkippedFolder(".polaris/runs")).toBe(false));
  it("skips generated .polaris/clusters descendants", () => expect(isCognitionSkippedFolder(".polaris/clusters/POL-201")).toBe(true));
  it("skips generated .polaris/runs descendants", () => expect(isCognitionSkippedFolder(".polaris/runs/polaris-run-1")).toBe(true));
  it("skips .claude agent folder", () => expect(isCognitionSkippedFolder(".claude")).toBe(true));
  it("does not skip src/", () => expect(isCognitionSkippedFolder("src")).toBe(false));
  it("does not skip src/loop", () => expect(isCognitionSkippedFolder("src/loop")).toBe(false));
  it("does not skip scripts/", () => expect(isCognitionSkippedFolder("scripts")).toBe(false));
});

describe("isPolarisOwnedFolder", () => {
  it("matches top-level .polaris", () => {
    expect(isPolarisOwnedFolder(".polaris")).toBe(true);
  });

  it("matches src root and immediate src subdirectories", () => {
    expect(isPolarisOwnedFolder("src")).toBe(true);
    expect(isPolarisOwnedFolder("src/loop")).toBe(true);
  });

  it("matches active smartdocs cognition folders", () => {
    expect(isPolarisOwnedFolder("smartdocs/specs/active")).toBe(true);
    expect(isPolarisOwnedFolder("smartdocs/doctrine/active")).toBe(true);
  });

  it("does not match nested src grandchildren or unrelated folders", () => {
    expect(isPolarisOwnedFolder("src/loop/worker")).toBe(false);
    expect(isPolarisOwnedFolder("docs")).toBe(false);
  });
});

describe("isUserCreatedCognitionSurface", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("returns true when file predates Polaris initialization", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    const target = join(tmp, "src", "loop", "POLARIS.md");
    writeFileSync(target, "# human", "utf-8");
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(target, old, old);
    mkdirSync(join(tmp, ".polaris"), { recursive: true });

    expect(isUserCreatedCognitionSurface("src/loop/POLARIS.md", tmp)).toBe(true);
  });

  it("returns true when listed in managed-surfaces manifest", () => {
    mkdirSync(join(tmp, ".polaris", "cognition"), { recursive: true });
    writeFileSync(
      join(tmp, ".polaris", "cognition", "managed-surfaces.json"),
      JSON.stringify({ surfaces: ["src/loop/SUMMARY.md"] }),
      "utf-8",
    );
    expect(isUserCreatedCognitionSurface("src/loop/SUMMARY.md", tmp)).toBe(true);
  });

  it("returns false for post-initialization files not listed in manifest", () => {
    mkdirSync(join(tmp, ".polaris"), { recursive: true });
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "SUMMARY.md"), "# generated", "utf-8");
    expect(isUserCreatedCognitionSurface("src/loop/SUMMARY.md", tmp)).toBe(false);
  });
});

// ── detectOperationalReasons ──────────────────────────────────────────────────

describe("detectOperationalReasons", () => {
  it("detects folder-responsibilities-changed from index.ts", () => {
    const reasons = detectOperationalReasons(["src/loop/index.ts"]);
    expect(reasons).toContain("folder-responsibilities-changed");
  });

  it("detects commands-workflows-changed from cli path", () => {
    const reasons = detectOperationalReasons(["src/cli/args.ts"]);
    expect(reasons).toContain("commands-workflows-changed");
  });

  it("detects execution-constraints-changed from config/schema.ts", () => {
    const reasons = detectOperationalReasons(["src/config/schema.ts"]);
    expect(reasons).toContain("execution-constraints-changed");
  });

  it("detects ownership-routing-changed from map/atlas.ts", () => {
    const reasons = detectOperationalReasons(["src/map/atlas.ts"]);
    expect(reasons).toContain("ownership-routing-changed");
  });

  it("detects operational-behavior-changed from worker.ts", () => {
    const reasons = detectOperationalReasons(["src/loop/worker.ts"]);
    expect(reasons).toContain("operational-behavior-changed");
  });

  it("returns empty for test files", () => {
    const reasons = detectOperationalReasons(["src/loop/worker.test.ts"]);
    expect(reasons).toHaveLength(0);
  });

  it("returns empty for non-operational markdown", () => {
    const reasons = detectOperationalReasons(["docs/some-doc.md"]);
    expect(reasons).toHaveLength(0);
  });

  it("returns empty for random json (non-config)", () => {
    const reasons = detectOperationalReasons(["data/fixtures.json"]);
    expect(reasons).toHaveLength(0);
  });
});

// ── findNearestRoutePolarismd ─────────────────────────────────────────────────

describe("findNearestRoutePolarismd", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("finds POLARIS.md in parent dir when skipRoot=true", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "POLARIS.md"), "# loop", "utf-8");
    const result = findNearestRoutePolarismd("src/loop/worker.ts", tmp, true);
    expect(result).toBe("src/loop/POLARIS.md");
  });

  it("skips root POLARIS.md when skipRoot=true", () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "POLARIS.md"), "# root", "utf-8");
    const result = findNearestRoutePolarismd("src/utils.ts", tmp, true);
    expect(result).toBeNull();
  });

  it("returns root POLARIS.md when skipRoot=false", () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "POLARIS.md"), "# root", "utf-8");
    const result = findNearestRoutePolarismd("src/utils.ts", tmp, false);
    expect(result).toBe("POLARIS.md");
  });

  it("finds nearest ancestor POLARIS.md", () => {
    mkdirSync(join(tmp, "src", "deep", "nested"), { recursive: true });
    writeFileSync(join(tmp, "src", "POLARIS.md"), "# src", "utf-8");
    const result = findNearestRoutePolarismd("src/deep/nested/file.ts", tmp, true);
    expect(result).toBe("src/POLARIS.md");
  });

  it("skips skipped folder paths", () => {
    mkdirSync(join(tmp, ".git", "hooks"), { recursive: true });
    writeFileSync(join(tmp, ".git", "POLARIS.md"), "# git", "utf-8");
    const result = findNearestRoutePolarismd(".git/hooks/commit-msg", tmp, true);
    expect(result).toBeNull();
  });
});

// ── applyRouteCognitionDelta ──────────────────────────────────────────────────

describe("applyRouteCognitionDelta", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("reports updateWarranted for operational files", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "POLARIS.md"), "# loop", "utf-8");

    const result = applyRouteCognitionDelta({
      repoRoot: tmp,
      touchedFiles: ["src/loop/worker.ts", "src/loop/dispatch.ts"],
      skipRoot: true,
    });

    expect(result.updateWarranted).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.routeLocalTargets).toContain("src/loop/POLARIS.md");
  });

  it("reports no update for test-only files", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "POLARIS.md"), "# loop", "utf-8");

    const result = applyRouteCognitionDelta({
      repoRoot: tmp,
      touchedFiles: ["src/loop/worker.test.ts"],
      skipRoot: true,
    });

    expect(result.updateWarranted).toBe(false);
  });

  it("detects missing POLARIS.md surfaces", () => {
    mkdirSync(join(tmp, "src", "newmod"), { recursive: true });

    const result = applyRouteCognitionDelta({
      repoRoot: tmp,
      touchedFiles: ["src/newmod/index.ts"],
      skipRoot: true,
    });

    expect(result.missingCognitionSurfaces).toContain("src/newmod");
  });

  it("does not scan root when skipRoot=true", () => {
    writeFileSync(join(tmp, "POLARIS.md"), "# root", "utf-8");

    const result = applyRouteCognitionDelta({
      repoRoot: tmp,
      touchedFiles: ["src/loop/worker.ts"],
      skipRoot: true,
    });

    expect(result.routeLocalTargets).not.toContain("POLARIS.md");
  });

  it("detects missing top-level Polaris runtime surfaces", () => {
    mkdirSync(join(tmp, ".polaris", "map"), { recursive: true });

    const result = applyRouteCognitionDelta({
      repoRoot: tmp,
      touchedFiles: [".polaris/map/file-routes.json"],
      skipRoot: true,
    });

    expect(result.missingCognitionSurfaces).toContain(".polaris/map");
  });
});

// ── archiveCognitionNotes ──────────────────────────────────────────────────────

describe("archiveCognitionNotes", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("moves reconciled notes into archive and writes provenance files", () => {
    mkdirSync(join(tmp, ".polaris", "cognition", "pending", "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, ".polaris", "cognition", "pending", "src", "loop", "note.md"), "hello", "utf-8");

    const result = archiveCognitionNotes({
      repoRoot: tmp,
      reconcileId: "reconcile-1",
      runId: "run-1",
      notesConsumed: ["src/loop/note.md"],
      polarisMdUpdated: true,
      summaryMdUpdated: false,
      result: { status: "success", applied: true },
    });

    expect(result.archivedNotes).toEqual([".polaris/cognition/archive/src/loop/note.md"]);
    expect(result.missingNotes).toEqual([]);
    expect(existsSync(join(tmp, ".polaris", "cognition", "pending", "src", "loop", "note.md"))).toBe(false);
    expect(readFileSync(join(tmp, ".polaris", "cognition", "archive", "src", "loop", "note.md"), "utf-8")).toBe("hello");
    expect(JSON.parse(readFileSync(join(tmp, ".polaris", "cognition", "archive", "src", "loop", ".reconcile-reconcile-1.json"), "utf-8"))).toEqual({
      status: "success",
      applied: true,
    });
    expect(JSON.parse(readFileSync(join(tmp, ".polaris", "cognition", "archive", "src", "loop", "cognition-index.json"), "utf-8"))).toEqual({
      entries: [
        {
          reconcile_id: "reconcile-1",
          run_id: "run-1",
          reconciled_at: expect.any(String),
          notes_consumed: ["note.md"],
          polaris_md_updated: true,
          summary_md_updated: false,
        },
      ],
    });
  });

  it("keeps partial archive progress discoverable when some notes are missing", () => {
    mkdirSync(join(tmp, ".polaris", "cognition", "pending", "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, ".polaris", "cognition", "pending", "src", "loop", "note.md"), "hello", "utf-8");

    const result = archiveCognitionNotes({
      repoRoot: tmp,
      reconcileId: "reconcile-2",
      runId: "run-2",
      notesConsumed: [
        "src/loop/note.md",
        "src/loop/missing.md",
      ],
      polarisMdUpdated: false,
      summaryMdUpdated: true,
    });

    expect(result.archivedNotes).toEqual([".polaris/cognition/archive/src/loop/note.md"]);
    expect(result.missingNotes).toEqual([".polaris/cognition/pending/src/loop/missing.md"]);
    expect(JSON.parse(readFileSync(join(tmp, ".polaris", "cognition", "archive", "src", "loop", "cognition-index.json"), "utf-8"))).toEqual({
      entries: [
        {
          reconcile_id: "reconcile-2",
          run_id: "run-2",
          reconciled_at: expect.any(String),
          notes_consumed: ["note.md"],
          polaris_md_updated: false,
          summary_md_updated: true,
        },
      ],
    });
  });

  it("keeps pending notes in place and records rejected librarian patches", () => {
    mkdirSync(join(tmp, ".polaris", "cognition", "pending", "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, ".polaris", "cognition", "pending", "src", "loop", "note.md"), "hello", "utf-8");

    const result = archiveCognitionNotes({
      repoRoot: tmp,
      reconcileId: "reconcile-3",
      runId: "run-3",
      notesConsumed: ["src/loop/note.md"],
      polarisMdUpdated: false,
      summaryMdUpdated: false,
      status: "rejected",
      rejectionReason: "validation failed",
      result: { status: "rejected" },
    });

    expect(result.archivedNotes).toEqual([]);
    expect(result.resultFiles).toEqual([]);
    expect(existsSync(join(tmp, ".polaris", "cognition", "pending", "src", "loop", "note.md"))).toBe(true);
    expect(existsSync(join(tmp, ".polaris", "cognition", "archive", "src", "loop", "note.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(tmp, ".polaris", "cognition", "pending", "src", "loop", "cognition-index.json"), "utf-8"))).toEqual({
      entries: [
        {
          event: "cognition-librarian-patch-rejected",
          reconcile_id: "reconcile-3",
          run_id: "run-3",
          rejected_at: expect.any(String),
          notes_consumed: ["note.md"],
          polaris_md_updated: false,
          summary_md_updated: false,
          reason: "validation failed",
        },
      ],
    });
  });
});

// ── detectSummaryReasons ──────────────────────────────────────────────────────

describe("detectSummaryReasons", () => {
  it("detects linked-docs-changed for spec raw path", () => {
    const reasons = detectSummaryReasons(["smartdocs/docs/specs/raw/arch.md"]);
    expect(reasons).toContain("linked-docs-changed");
  });

  it("detects doctrine-spec-linkage-changed for AGENTS.md", () => {
    const reasons = detectSummaryReasons(["AGENTS.md"]);
    expect(reasons).toContain("canon-relationships-changed");
  });

  it("detects architecture-meaning-changed for architecture docs", () => {
    const reasons = detectSummaryReasons(["smartdocs/docs/architecture/overview.md"]);
    expect(reasons).toContain("architecture-meaning-changed");
  });

  it("returns empty for implementation source files", () => {
    const reasons = detectSummaryReasons(["src/loop/worker.ts"]);
    expect(reasons).toHaveLength(0);
  });

  it("detects config change as canon relationship", () => {
    const reasons = detectSummaryReasons(["polaris.config.json"]);
    expect(reasons).toContain("canon-relationships-changed");
  });
});

// ── applySummaryDelta ─────────────────────────────────────────────────────────

describe("applySummaryDelta", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("reports updateWarranted for spec changes", () => {
    const result = applySummaryDelta({
      repoRoot: tmp,
      touchedFiles: ["smartdocs/docs/specs/raw/some-spec.md"],
      skipRoot: true,
    });
    expect(result.updateWarranted).toBe(true);
  });

  it("reports no update for implementation source", () => {
    const result = applySummaryDelta({
      repoRoot: tmp,
      touchedFiles: ["src/loop/checkpoint.ts"],
      skipRoot: true,
    });
    expect(result.updateWarranted).toBe(false);
  });

  it("finds existing SUMMARY.md targets", () => {
    mkdirSync(join(tmp, "smartdocs", "docs", "specs", "raw"), { recursive: true });
    mkdirSync(join(tmp, "smartdocs", "docs", "specs"), { recursive: true });
    writeFileSync(join(tmp, "smartdocs", "docs", "specs", "SUMMARY.md"), "# specs summary", "utf-8");

    const result = applySummaryDelta({
      repoRoot: tmp,
      touchedFiles: ["smartdocs/docs/specs/raw/some.md"],
      skipRoot: true,
    });
    expect(result.summaryTargets).toContain("smartdocs/docs/specs/SUMMARY.md");
  });

  it("detects folders with POLARIS.md but no SUMMARY.md", () => {
    mkdirSync(join(tmp, "src", "map"), { recursive: true });
    writeFileSync(join(tmp, "src", "map", "POLARIS.md"), "# map", "utf-8");

    const result = applySummaryDelta({
      repoRoot: tmp,
      touchedFiles: ["src/map/POLARIS.md"],
      skipRoot: true,
    });
    expect(result.missingSummaries).toContain("src/map");
  });
});

// ── detectPrecedenceLevel ─────────────────────────────────────────────────────

describe("detectPrecedenceLevel", () => {
  it("returns promoted-doctrine for active doctrine path", () => {
    expect(detectPrecedenceLevel(["smartdocs/docs/doctrine/active/foo.md"])).toBe("promoted-doctrine");
  });

  it("returns spec-or-arch for active spec path", () => {
    expect(detectPrecedenceLevel(["smartdocs/docs/specs/active/bar.md"])).toBe("spec-or-arch");
  });

  it("returns spec-or-arch for architecture doc", () => {
    expect(detectPrecedenceLevel(["smartdocs/docs/architecture/overview.md"])).toBe("spec-or-arch");
  });

  it("returns spec-or-arch for specs/raw/ path", () => {
    expect(detectPrecedenceLevel(["smartdocs/docs/specs/raw/polaris-spec.md"])).toBe("spec-or-arch");
  });

  it("returns route-polaris-md when only a POLARIS.md is touched", () => {
    expect(detectPrecedenceLevel(["src/loop/POLARIS.md"])).toBe("route-polaris-md");
  });

  it("returns source-inference for plain source files", () => {
    expect(detectPrecedenceLevel(["src/loop/worker.ts"])).toBe("source-inference");
  });

  it("promoted-doctrine wins over spec-or-arch in same batch", () => {
    expect(detectPrecedenceLevel([
      "smartdocs/docs/specs/raw/polaris-spec.md",
      "smartdocs/docs/doctrine/active/core.md",
    ])).toBe("promoted-doctrine");
  });

  it("spec-or-arch wins over route-polaris-md in same batch", () => {
    expect(detectPrecedenceLevel([
      "src/map/POLARIS.md",
      "smartdocs/docs/architecture/overview.md",
    ])).toBe("spec-or-arch");
  });
});

// ── isSummaryOversized / hasDoctrineBled ──────────────────────────────────────

describe("isSummaryOversized", () => {
  it("returns false for short content", () => {
    expect(isSummaryOversized("# Summary\n\nShort.")).toBe(false);
  });

  it("returns true when content exceeds SUMMARY_MAX_BYTES", () => {
    const oversized = "x".repeat(SUMMARY_MAX_BYTES + 1);
    expect(isSummaryOversized(oversized)).toBe(true);
  });
});

describe("hasDoctrineBled", () => {
  it("detects '## Editing rules' section heading as doctrine bleed", () => {
    expect(hasDoctrineBled("## Editing rules\n\nDo not add side effects.")).toBe(true);
  });

  it("detects '## Constraints' section heading as doctrine bleed", () => {
    expect(hasDoctrineBled("## Constraints\n\nMust not skip.")).toBe(true);
  });

  it("detects strong imperative 'must always' at line start as doctrine bleed", () => {
    expect(hasDoctrineBled("Workers must always stop after one child.")).toBe(true);
  });

  it("returns false for bare 'never' in prose (not imperative heading)", () => {
    expect(hasDoctrineBled("This module never directly writes to disk.")).toBe(false);
  });

  it("returns false for 'do not' in quoted context", () => {
    expect(hasDoctrineBled("The spec says \"do not skip validation\" in section 3.")).toBe(false);
  });

  it("returns false for normal informational content", () => {
    expect(hasDoctrineBled("# Summary\n\nThis module handles state management.")).toBe(false);
  });
});

// ── validateCognitionSurfaces / validateSummaryFile ───────────────────────────

describe("validateCognitionSurfaces", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("returns valid when no cognition files exist below root", () => {
    const result = validateCognitionSurfaces(tmp);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects oversized SUMMARY.md", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "SUMMARY.md"), "x".repeat(SUMMARY_MAX_BYTES + 100), "utf-8");

    const result = validateCognitionSurfaces(tmp);
    const oversized = result.violations.filter((v) => v.type === "summary-oversized");
    expect(oversized).toHaveLength(1);
    expect(oversized[0].file).toBe("src/loop/SUMMARY.md");
  });

  it("puts doctrine bleed in warnings (not violations) and does not fail valid", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "SUMMARY.md"), "Workers must always stop after one child.", "utf-8");

    const result = validateCognitionSurfaces(tmp);
    // Doctrine bleed is warn-only — must not fail validation
    expect(result.valid).toBe(true);
    expect(result.violations.filter((v) => v.type === "summary-doctrine-bleed")).toHaveLength(0);
    expect(result.warnings.filter((v) => v.type === "summary-doctrine-bleed")).toHaveLength(1);
  });

  it("skips root-level POLARIS.md", () => {
    writeFileSync(join(tmp, "POLARIS.md"), "# Root", "utf-8");
    const result = validateCognitionSurfaces(tmp);
    expect(result.valid).toBe(true);
  });

  it("skips skipped folders (.git, node_modules, etc.)", () => {
    mkdirSync(join(tmp, ".git"), { recursive: true });
    writeFileSync(join(tmp, ".git", "SUMMARY.md"), "must always do X", "utf-8");
    const result = validateCognitionSurfaces(tmp);
    expect(result.valid).toBe(true);
  });
});

describe("validateSummaryFile", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("returns no violations for a clean summary", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "SUMMARY.md"), "# Summary\n\nContextual summary only.", "utf-8");
    const violations = validateSummaryFile("src/loop/SUMMARY.md", tmp);
    expect(violations).toHaveLength(0);
  });

  it("returns warn-severity entry for doctrine bleed section heading", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "SUMMARY.md"), "## Editing rules\nNever skip.", "utf-8");
    const results = validateSummaryFile("src/loop/SUMMARY.md", tmp);
    const bleed = results.find((v) => v.type === "summary-doctrine-bleed");
    expect(bleed).toBeDefined();
    expect(bleed!.severity).toBe("warn");
  });
});

// ── looksLikePolarisChurn ─────────────────────────────────────────────────────

describe("looksLikePolarisChurn", () => {
  it("detects identical content as churn", () => {
    const content = "# Loop\n\nHandles session lifecycle.";
    expect(looksLikePolarisChurn(content, content)).toBe(true);
  });

  it("detects whitespace-only diff as churn", () => {
    expect(looksLikePolarisChurn("# Loop\n\nHandles sessions.", "# Loop\n\n\nHandles sessions.\n")).toBe(true);
  });

  it("does not flag substantive diff as churn", () => {
    const before = "# Loop\n\nHandles sessions.";
    const after = "# Loop\n\nHandles sessions.\n\n## New Section\n\nAdded new behavior.";
    expect(looksLikePolarisChurn(before, after)).toBe(false);
  });
});

// ── detectMissingCognitionSurfaces (map/update) ───────────────────────────────

describe("detectMissingCognitionSurfaces", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("reports folder missing POLARIS.md for a touched file", () => {
    mkdirSync(join(tmp, "src", "newmod"), { recursive: true });

    const { missingPolaris } = detectMissingCognitionSurfaces(
      ["src/newmod/index.ts"],
      tmp,
    );
    expect(missingPolaris).toContain("src/newmod");
  });

  it("does not report a folder that already has POLARIS.md", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "POLARIS.md"), "# loop", "utf-8");

    const { missingPolaris } = detectMissingCognitionSurfaces(
      ["src/loop/worker.ts"],
      tmp,
    );
    expect(missingPolaris).not.toContain("src/loop");
  });

  it("reports folder with POLARIS.md but no SUMMARY.md as missing summary", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "POLARIS.md"), "# loop", "utf-8");

    const { missingSummary } = detectMissingCognitionSurfaces(
      ["src/loop/worker.ts"],
      tmp,
    );
    expect(missingSummary).toContain("src/loop");
  });

  it("does not report skipped folders", () => {
    mkdirSync(join(tmp, ".taskchain_artifacts", "polaris-run"), { recursive: true });

    const { missingPolaris } = detectMissingCognitionSurfaces(
      [".taskchain_artifacts/polaris-run/current-state.json"],
      tmp,
    );
    expect(missingPolaris).not.toContain(".taskchain_artifacts/polaris-run");
  });

  it("always reports existing Polaris-owned folders that are missing POLARIS.md", () => {
    mkdirSync(join(tmp, ".polaris"), { recursive: true });
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    mkdirSync(join(tmp, "smartdocs", "specs", "active"), { recursive: true });

    const { missingPolaris } = detectMissingCognitionSurfaces([], tmp);
    expect(missingPolaris).toContain(".polaris");
    expect(missingPolaris).toContain("src");
    expect(missingPolaris).toContain("src/loop");
    expect(missingPolaris).toContain("smartdocs/specs/active");
  });

  it("does not mark adaptive folders eligible when changes are test-only", () => {
    mkdirSync(join(tmp, "scripts", "feature"), { recursive: true });
    const { missingPolaris } = detectMissingCognitionSurfaces(
      ["scripts/feature/worker.test.ts"],
      tmp,
    );
    expect(missingPolaris).not.toContain("scripts/feature");
  });

  it("does not report root-level folder", () => {
    const { missingPolaris } = detectMissingCognitionSurfaces(
      ["README.md"],
      tmp,
    );
    expect(missingPolaris).not.toContain("");
  });
});

// ── seedCognitionDrafts ───────────────────────────────────────────────────────

describe("seedCognitionDrafts", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("creates draft POLARIS.md for eligible folders when seeding", () => {
    mkdirSync(join(tmp, "src", "newmod"), { recursive: true });

    const seeded = seedCognitionDrafts(
      { polaris: ["src/newmod"], summary: [] },
      tmp,
    );

    expect(seeded).toContain("src/newmod/POLARIS.md");
    expect(existsSync(join(tmp, "src", "newmod", "POLARIS.md"))).toBe(true);
    const content = readFileSync(join(tmp, "src", "newmod", "POLARIS.md"), "utf-8");
    // Draft only — scaffold headings with TODO placeholders, no filled content
    expect(content).toContain("DRAFT");
    expect(content).toContain("## Purpose");
    expect(content).toContain("<!-- TODO -->");
  });

  it("creates draft SUMMARY.md for eligible folders when seeding", () => {
    mkdirSync(join(tmp, "src", "map"), { recursive: true });
    writeFileSync(join(tmp, "src", "map", "POLARIS.md"), "# map", "utf-8");

    const seeded = seedCognitionDrafts(
      { polaris: [], summary: ["src/map"] },
      tmp,
    );

    expect(seeded).toContain("src/map/SUMMARY.md");
    expect(existsSync(join(tmp, "src", "map", "SUMMARY.md"))).toBe(true);
    const content = readFileSync(join(tmp, "src", "map", "SUMMARY.md"), "utf-8");
    // Draft only — no filled content, operator must complete
    expect(content).toContain("DRAFT");
    expect(content).toContain("Informational only");
  });

  it("does not overwrite existing files", () => {
    mkdirSync(join(tmp, "src", "loop"), { recursive: true });
    writeFileSync(join(tmp, "src", "loop", "POLARIS.md"), "# existing content", "utf-8");

    seedCognitionDrafts({ polaris: ["src/loop"], summary: [] }, tmp);

    const content = readFileSync(join(tmp, "src", "loop", "POLARIS.md"), "utf-8");
    expect(content).toBe("# existing content");
  });

  it("skips skipped folders", () => {
    const seeded = seedCognitionDrafts(
      { polaris: [".taskchain_artifacts/polaris-run"], summary: [] },
      tmp,
    );
    expect(seeded).toHaveLength(0);
    expect(existsSync(join(tmp, ".taskchain_artifacts", "polaris-run", "POLARIS.md"))).toBe(false);
  });

  it("does not create files during default map update (no seedCognition flag)", () => {
    // This test verifies the integration contract: seedCognitionDrafts is only
    // called when seedCognition=true is explicitly passed to runMapUpdate.
    // Without that flag, detectMissingCognitionSurfaces runs but creates nothing.
    mkdirSync(join(tmp, "src", "newmod"), { recursive: true });

    // Calling detectMissing but NOT seedCognitionDrafts simulates default behavior
    const { missingPolaris } = detectMissingCognitionSurfaces(
      ["src/newmod/index.ts"],
      tmp,
    );

    // Detection reports missing
    expect(missingPolaris).toContain("src/newmod");
    // But no files were created
    expect(existsSync(join(tmp, "src", "newmod", "POLARIS.md"))).toBe(false);
  });
});

// ── --include-root behavior ───────────────────────────────────────────────────

describe("detectMissingCognitionSurfaces --include-root", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("does NOT report root when includeRoot is false/omitted", () => {
    // Root-level file with no POLARIS.md at root
    const { missingPolaris } = detectMissingCognitionSurfaces(
      ["README.md"],
      tmp,
    );
    expect(missingPolaris).not.toContain("");
  });

  it("reports root as missing when includeRoot=true and no root POLARIS.md", () => {
    // A top-level file (no sub-folder ancestor to find)
    const { missingPolaris } = detectMissingCognitionSurfaces(
      ["README.md"],
      tmp,
      true,
    );
    expect(missingPolaris).toContain("");
  });

  it("does NOT report root when root already has POLARIS.md and includeRoot=true", () => {
    writeFileSync(join(tmp, "POLARIS.md"), "# root", "utf-8");
    const { missingPolaris } = detectMissingCognitionSurfaces(
      ["README.md"],
      tmp,
      true,
    );
    expect(missingPolaris).not.toContain("");
  });

  it("reports root as missing SUMMARY.md when includeRoot=true and has POLARIS.md only", () => {
    writeFileSync(join(tmp, "POLARIS.md"), "# root", "utf-8");
    const { missingSummary } = detectMissingCognitionSurfaces(
      ["README.md"],
      tmp,
      true,
    );
    expect(missingSummary).toContain("");
  });
});

describe("seedCognitionDrafts --include-root", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it("skips root by default (includeRoot omitted)", () => {
    const seeded = seedCognitionDrafts({ polaris: [""], summary: [] }, tmp);
    expect(seeded).toHaveLength(0);
    expect(existsSync(join(tmp, "POLARIS.md"))).toBe(false);
  });

  it("seeds root POLARIS.md when includeRoot=true", () => {
    const seeded = seedCognitionDrafts({ polaris: [""], summary: [] }, tmp, true);
    expect(seeded).toContain("POLARIS.md");
    expect(existsSync(join(tmp, "POLARIS.md"))).toBe(true);
  });

  it("seeds root SUMMARY.md when includeRoot=true", () => {
    writeFileSync(join(tmp, "POLARIS.md"), "# root", "utf-8");
    const seeded = seedCognitionDrafts({ polaris: [], summary: [""] }, tmp, true);
    expect(seeded).toContain("SUMMARY.md");
    expect(existsSync(join(tmp, "SUMMARY.md"))).toBe(true);
  });

  it("does not overwrite existing root POLARIS.md even with includeRoot=true", () => {
    writeFileSync(join(tmp, "POLARIS.md"), "# existing root", "utf-8");
    seedCognitionDrafts({ polaris: [""], summary: [] }, tmp, true);
    expect(readFileSync(join(tmp, "POLARIS.md"), "utf-8")).toBe("# existing root");
  });
});
