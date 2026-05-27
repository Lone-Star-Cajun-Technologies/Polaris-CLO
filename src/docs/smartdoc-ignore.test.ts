import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SMARTDOCIGNORE_PATTERNS,
  isIngestIneligible,
  parseSmartDocIgnore,
} from "./smartdoc-ignore.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "polaris-smartdoc-ignore-"));
}

describe("parseSmartDocIgnore", () => {
  it("enforces default endpoint artifact patterns when .smartdocignore is absent", () => {
    const repoRoot = makeRepo();

    expect(DEFAULT_SMARTDOCIGNORE_PATTERNS).toContain(".taskchain_artifacts/**");
    expect(isIngestIneligible(".taskchain_artifacts/polaris-run/current-state.json", repoRoot)).toEqual({
      ineligible: true,
      reason: "ignored by .smartdocignore/defaults: .taskchain_artifacts/polaris-run/current-state.json",
    });
  });

  it("enforces all default endpoint artifact families", () => {
    const repoRoot = makeRepo();

    for (const path of [
      "README.md",
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      "POLARIS.md",
      ".claude/settings.json",
      ".codex/AGENTS.md",
      ".windsurf/rules.md",
      ".github/workflows/ci.yml",
      "generated/report.md",
      "docs/generated/report.md",
      "summaries/run.md",
      "docs/summaries/run.md",
      "smartdocs/docs/specs/active/example.md",
    ]) {
      expect(isIngestIneligible(path, repoRoot).ineligible, path).toBe(true);
    }
  });

  it("parses custom gitignore-style patterns from .smartdocignore", () => {
    const repoRoot = makeRepo();
    writeFileSync(join(repoRoot, ".smartdocignore"), "scratch/**/*.md\n!important.md\n", "utf-8");

    expect(isIngestIneligible("scratch/plans/test.md", repoRoot).ineligible).toBe(true);
    expect(isIngestIneligible("important.md", repoRoot).ineligible).toBe(false);
  });

  it("allows non-ignored paths", () => {
    const repoRoot = makeRepo();
    mkdirSync(join(repoRoot, "docs", "raw"), { recursive: true });
    writeFileSync(join(repoRoot, ".smartdocignore"), "tmp/\n", "utf-8");

    expect(isIngestIneligible("docs/raw/spec.md", repoRoot)).toEqual({ ineligible: false });
    expect(parseSmartDocIgnore(repoRoot).ignores("docs/raw/spec.md")).toBe(false);
  });
});
