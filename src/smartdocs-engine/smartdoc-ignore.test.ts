import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SMARTDOCIGNORE_PATTERNS,
  isIngestIneligible,
  parseSmartDocIgnore,
  isDirectoryEligible,
  RUNTIME_EXCLUDED_DIR_PATTERNS,
  AGENT_COGNITION_FOLDERS,
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
    mkdirSync(join(repoRoot, "smartdocs", "docs", "raw"), { recursive: true });
    writeFileSync(join(repoRoot, ".smartdocignore"), "tmp/\n", "utf-8");

    expect(isIngestIneligible("smartdocs/docs/raw/spec.md", repoRoot)).toEqual({ ineligible: false });
    expect(parseSmartDocIgnore(repoRoot).ignores("smartdocs/docs/raw/spec.md")).toBe(false);
  });
});

describe("isDirectoryEligible", () => {
  it("marks build artifact directories as ineligible", () => {
    const repoRoot = makeRepo();

    for (const dir of ["node_modules", "dist", "build", "coverage"]) {
      const fullPath = join(repoRoot, dir);
      mkdirSync(fullPath, { recursive: true });
      const result = isDirectoryEligible(fullPath, repoRoot);
      expect(result.eligible, dir).toBe(false);
      expect(result.reason, dir).toContain("runtime artifact excluded");
      expect(result.category, dir).toBe("runtime");
    }
  });

  it("marks runtime and system hidden directories as ineligible", () => {
    const repoRoot = makeRepo();

    for (const dir of [".git", ".github", ".windsurf"]) {
      const fullPath = join(repoRoot, dir);
      mkdirSync(fullPath, { recursive: true });
      const result = isDirectoryEligible(fullPath, repoRoot);
      expect(result.eligible, dir).toBe(false);
      expect(result.category, dir).toMatch(/runtime|hidden/);
    }
  });

  it("allows top-level Polaris runtime cognition directories", () => {
    const repoRoot = makeRepo();

    for (const dir of [".polaris", ".polaris/bootstrap", ".polaris/clusters", ".polaris/map", ".polaris/runs"]) {
      const fullPath = join(repoRoot, dir);
      mkdirSync(fullPath, { recursive: true });
      const result = isDirectoryEligible(fullPath, repoRoot);
      expect(result.eligible, dir).toBe(true);
      expect(result.category, dir).toBe("eligible");
    }
  });

  it("keeps generated Polaris runtime descendants ineligible", () => {
    const repoRoot = makeRepo();

    for (const dir of [".polaris/bootstrap/snapshots", ".polaris/clusters/POL-123", ".polaris/map/archive", ".polaris/runs/run-123"]) {
      const fullPath = join(repoRoot, dir);
      mkdirSync(fullPath, { recursive: true });
      const result = isDirectoryEligible(fullPath, repoRoot);
      expect(result.eligible, dir).toBe(false);
      expect(result.reason, dir).toContain("generated Polaris runtime directory excluded");
      expect(result.category, dir).toBe("runtime");
    }
  });

  it("marks nested ineligible directories as ineligible", () => {
    const repoRoot = makeRepo();
    mkdirSync(join(repoRoot, "src", "node_modules"), { recursive: true });

    const result = isDirectoryEligible(join(repoRoot, "src", "node_modules"), repoRoot);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("runtime artifact excluded: node_modules");
    expect(result.category).toBe("runtime");
  });

  it("marks directories ignored by .smartdocignore as ineligible", () => {
    const repoRoot = makeRepo();
    mkdirSync(join(repoRoot, "custom-ignore"), { recursive: true });
    writeFileSync(join(repoRoot, ".smartdocignore"), "custom-ignore/\n", "utf-8");

    const result = isDirectoryEligible(join(repoRoot, "custom-ignore"), repoRoot);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("ignored by .smartdocignore");
  });

  it("marks eligible source directories as eligible", () => {
    const repoRoot = makeRepo();

    for (const dir of ["src", "docs", "lib", "packages", "core"]) {
      const fullPath = join(repoRoot, dir);
      mkdirSync(fullPath, { recursive: true });
      const result = isDirectoryEligible(fullPath, repoRoot);
      expect(result.eligible, dir).toBe(true);
    }
  });

  it("includes all expected runtime excluded patterns", () => {
    expect(RUNTIME_EXCLUDED_DIR_PATTERNS).toContain("node_modules");
    expect(RUNTIME_EXCLUDED_DIR_PATTERNS).toContain("dist");
    expect(RUNTIME_EXCLUDED_DIR_PATTERNS).toContain("build");
    expect(RUNTIME_EXCLUDED_DIR_PATTERNS).toContain("coverage");
    expect(RUNTIME_EXCLUDED_DIR_PATTERNS).toContain(".git");
    expect(RUNTIME_EXCLUDED_DIR_PATTERNS).not.toContain(".polaris");
    expect(RUNTIME_EXCLUDED_DIR_PATTERNS).toContain("generated");
    expect(RUNTIME_EXCLUDED_DIR_PATTERNS).not.toContain("smartdocs"); // smartdocs/ protected via targeted DEFAULT_SMARTDOCIGNORE_PATTERNS
  });

  it("marks agent cognition folders as temporarily skipped with agent-cognition category", () => {
    const repoRoot = makeRepo();

    for (const dir of AGENT_COGNITION_FOLDERS) {
      const fullPath = join(repoRoot, dir);
      mkdirSync(fullPath, { recursive: true });
      const result = isDirectoryEligible(fullPath, repoRoot);
      expect(result.eligible, dir).toBe(false);
      expect(result.category, dir).toBe("agent-cognition");
      expect(result.reason, dir).toContain("agent cognition folder temporarily skipped");
    }
  });

  it("allows agent cognition folders with includeAgentFolders option", () => {
    const repoRoot = makeRepo();

    for (const dir of AGENT_COGNITION_FOLDERS) {
      const fullPath = join(repoRoot, dir);
      mkdirSync(fullPath, { recursive: true });
      const result = isDirectoryEligible(fullPath, repoRoot, { includeAgentFolders: true });
      expect(result.eligible, dir).toBe(true);
      expect(result.category, dir).toBe("eligible");
    }
  });

  it("marks root as skipped by default with root category", () => {
    const repoRoot = makeRepo();
    const result = isDirectoryEligible(repoRoot, repoRoot, { isRoot: true });
    expect(result.eligible).toBe(false);
    expect(result.category).toBe("root");
    expect(result.reason).toContain("root skipped by default");
  });

  it("allows root with skipRoot: false option", () => {
    const repoRoot = makeRepo();
    const result = isDirectoryEligible(repoRoot, repoRoot, { isRoot: true, skipRoot: false });
    expect(result.eligible).toBe(true);
    expect(result.category).toBe("eligible");
  });
});
