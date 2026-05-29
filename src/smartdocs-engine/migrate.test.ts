import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach } from "vitest";
import { isAllowedException, migrateDocs } from "./migrate.js";

// ---------------------------------------------------------------------------
// isAllowedException
// ---------------------------------------------------------------------------

describe("isAllowedException", () => {
  it("allows README.md in any directory", () => {
    expect(isAllowedException("README.md").allowed).toBe(true);
    expect(isAllowedException("src/README.md").allowed).toBe(true);
    expect(isAllowedException("some/deep/path/README.md").allowed).toBe(true);
  });

  it("allows POLARIS.md in any directory", () => {
    expect(isAllowedException("POLARIS.md").allowed).toBe(true);
    expect(isAllowedException("src/cli/POLARIS.md").allowed).toBe(true);
  });

  it("allows CHANGELOG.md and LICENSE.md", () => {
    expect(isAllowedException("CHANGELOG.md").allowed).toBe(true);
    expect(isAllowedException("LICENSE.md").allowed).toBe(true);
  });

  it("does NOT allow arbitrary docs/ files (docs/ is a migration source, not an exception)", () => {
    expect(isAllowedException("docs/spec/foo.md").allowed).toBe(false);
    expect(isAllowedException("docs/raw/bar.md").allowed).toBe(false);
  });

  it("allows anything under .agents/, .codex/, .claude/, .taskchain_artifacts/", () => {
    expect(isAllowedException(".agents/instructions.md").allowed).toBe(true);
    expect(isAllowedException(".codex/skills/foo/SKILL.md").allowed).toBe(true);
    expect(isAllowedException(".claude/CLAUDE.md").allowed).toBe(true);
    expect(isAllowedException(".taskchain_artifacts/run/notes.md").allowed).toBe(true);
  });

  it("allows anything under .polaris/skills/, .gemini/, .github/skills/", () => {
    expect(isAllowedException(".polaris/skills/polaris-run/SKILL.md").allowed).toBe(true);
    expect(isAllowedException(".gemini/skills/polaris-run/SKILL.md").allowed).toBe(true);
    expect(isAllowedException(".github/skills/polaris-run/SKILL.md").allowed).toBe(true);
  });

  it("does NOT allow arbitrary markdown files", () => {
    expect(isAllowedException("src/some-feature/NOTES.md").allowed).toBe(false);
    expect(isAllowedException("planning/ideas.md").allowed).toBe(false);
    expect(isAllowedException("scratch.md").allowed).toBe(false);
  });

  it("allows AGENTS.md, CLAUDE.md, GEMINI.md, COPILOT.md in any directory", () => {
    expect(isAllowedException("AGENTS.md").allowed).toBe(true);
    expect(isAllowedException("src/AGENTS.md").allowed).toBe(true);
    expect(isAllowedException("CLAUDE.md").allowed).toBe(true);
    expect(isAllowedException("src/CLAUDE.md").allowed).toBe(true);
    expect(isAllowedException("GEMINI.md").allowed).toBe(true);
    expect(isAllowedException("src/GEMINI.md").allowed).toBe(true);
    expect(isAllowedException("COPILOT.md").allowed).toBe(true);
  });

  it("allows files in smartdocs/, generated/, summaries/", () => {
    expect(isAllowedException("smartdocs/some-doc.md").allowed).toBe(true);
    expect(isAllowedException("generated/output.md").allowed).toBe(true);
    expect(isAllowedException("summaries/summary.md").allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// migrateDocs — dry-run
// ---------------------------------------------------------------------------

function makeGitRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "polaris-migrate-"));
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  return repoRoot;
}

function addTrackedFile(repoRoot: string, relPath: string, content = "# Doc\n\nContent"): void {
  const absPath = join(repoRoot, relPath);
  mkdirSync(join(repoRoot, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(absPath, content, "utf-8");
  execFileSync("git", ["add", relPath], { cwd: repoRoot });
}

describe("migrateDocs --dry-run", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeGitRepo();
  });

  it("reports files to migrate and allowed exceptions, does not move files", () => {
    addTrackedFile(repoRoot, "README.md");
    addTrackedFile(repoRoot, "planning/ideas.md");
    addTrackedFile(repoRoot, "docs/spec/existing.md");

    const result = migrateDocs({ repoRoot, dryRun: true, migrationRunId: "test-migrate-001" });

    expect(result.dryRun).toBe(true);
    expect(result.migrationRunId).toBe("test-migrate-001");

    const migrated = result.results.filter((r) => r.classification === "migrated");
    const exceptions = result.results.filter((r) => r.classification === "allowed-exception");

    expect(migrated).toHaveLength(2);
    const migratedPaths = migrated.map((r) => r.originalPath);
    expect(migratedPaths).toContain("planning/ideas.md");
    expect(migratedPaths).toContain("docs/spec/existing.md");

    expect(exceptions.length).toBeGreaterThanOrEqual(1);

    // Files must NOT have been moved
    expect(existsSync(join(repoRoot, "planning/ideas.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "smartdocs/docs/raw/ideas.md"))).toBe(false);

    // No provenance written in dry-run
    expect(result.provenancePath).toBeNull();
  });

  it("produces ingest batches of at most 4 files", () => {
    for (let i = 0; i < 9; i++) {
      addTrackedFile(repoRoot, `planning/doc${i}.md`);
    }

    const result = migrateDocs({ repoRoot, dryRun: true, migrationRunId: "test-migrate-002" });
    const allBatched = result.ingestBatches.flat();
    expect(allBatched).toHaveLength(9);
    for (const batch of result.ingestBatches) {
      expect(batch.length).toBeLessThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// migrateDocs — actual migration
// ---------------------------------------------------------------------------

describe("migrateDocs (live)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeGitRepo();
  });

  it("moves files to smartdocs/docs/raw/, writes provenance JSON", () => {
    addTrackedFile(repoRoot, "README.md");
    addTrackedFile(repoRoot, "scratch/notes.md", "# Notes");

    const result = migrateDocs({ repoRoot, dryRun: false, migrationRunId: "test-migrate-live-001" });

    expect(result.dryRun).toBe(false);

    const migrated = result.results.filter((r) => r.classification === "migrated");
    expect(migrated).toHaveLength(1);
    expect(migrated[0].originalPath).toBe("scratch/notes.md");
    expect(migrated[0].currentPath).toBe("smartdocs/docs/raw/notes.md");

    // File should now exist in smartdocs/docs/raw/
    expect(existsSync(join(repoRoot, "smartdocs/docs/raw/notes.md"))).toBe(true);
    // File should no longer exist at original location
    expect(existsSync(join(repoRoot, "scratch/notes.md"))).toBe(false);

    // Provenance written
    expect(result.provenancePath).not.toBeNull();
    const provContent = JSON.parse(
      readFileSync(join(repoRoot, result.provenancePath!), "utf-8"),
    ) as Array<{ originalPath: string; currentPath: string; migratedAt: string; migrationRunId: string }>;
    expect(provContent).toHaveLength(1);
    expect(provContent[0].originalPath).toBe("scratch/notes.md");
    expect(provContent[0].currentPath).toBe("smartdocs/docs/raw/notes.md");
    expect(provContent[0].migrationRunId).toBe("test-migrate-live-001");
    expect(provContent[0].migratedAt).toBeTruthy();
  });

  it("excludes AGENTS.md, CLAUDE.md, GEMINI.md from migration queue by default", () => {
    addTrackedFile(repoRoot, "AGENTS.md", "# Agents");
    addTrackedFile(repoRoot, "CLAUDE.md", "# Claude");
    addTrackedFile(repoRoot, "GEMINI.md", "# Gemini");
    addTrackedFile(repoRoot, "scratch/notes.md", "# Notes");

    const result = migrateDocs({ repoRoot, dryRun: true, migrationRunId: "test-endpoint-001" });

    const migrated = result.results.filter((r) => r.classification === "migrated");
    const exceptions = result.results.filter((r) => r.classification === "allowed-exception");

    // Only scratch/notes.md should be migrated
    expect(migrated).toHaveLength(1);
    expect(migrated[0].originalPath).toBe("scratch/notes.md");

    // AGENTS.md, CLAUDE.md, GEMINI.md should be exceptions
    const exceptionPaths = exceptions.map((r) => r.originalPath);
    expect(exceptionPaths).toContain("AGENTS.md");
    expect(exceptionPaths).toContain("CLAUDE.md");
    expect(exceptionPaths).toContain("GEMINI.md");
  });

  it("does not re-migrate files in smartdocs/", () => {
    addTrackedFile(repoRoot, "smartdocs/smart-doc.md", "# Smart Doc");
    addTrackedFile(repoRoot, "scratch/notes.md", "# Notes");

    const result = migrateDocs({ repoRoot, dryRun: true, migrationRunId: "test-endpoint-002" });

    const migrated = result.results.filter((r) => r.classification === "migrated");
    const exceptions = result.results.filter((r) => r.classification === "allowed-exception");

    expect(migrated).toHaveLength(1);
    expect(migrated[0].originalPath).toBe("scratch/notes.md");

    const exceptionPaths = exceptions.map((r) => r.originalPath);
    expect(exceptionPaths).toContain("smartdocs/smart-doc.md");
  });

  it("respects .smartdocignore custom patterns in migrate", () => {
    // Write a .smartdocignore with a custom pattern
    writeFileSync(join(repoRoot, ".smartdocignore"), "custom-ignore/**\n", "utf-8");
    execFileSync("git", ["add", ".smartdocignore"], { cwd: repoRoot });

    addTrackedFile(repoRoot, "custom-ignore/secret.md", "# Secret");
    addTrackedFile(repoRoot, "scratch/notes.md", "# Notes");

    const result = migrateDocs({ repoRoot, dryRun: true, migrationRunId: "test-endpoint-003" });

    const migrated = result.results.filter((r) => r.classification === "migrated");
    const exceptions = result.results.filter((r) => r.classification === "allowed-exception");

    expect(migrated).toHaveLength(1);
    expect(migrated[0].originalPath).toBe("scratch/notes.md");

    const smartdocExceptions = exceptions.filter(
      (r) => r.endpointArtifactReason === "smartdocignore-endpoint-artifact",
    );
    expect(smartdocExceptions.length).toBeGreaterThanOrEqual(1);
    const ignoredPaths = smartdocExceptions.map((r) => r.originalPath);
    expect(ignoredPaths).toContain("custom-ignore/secret.md");
  });

  it("handles filename collisions by uniquifying destination", () => {
    mkdirSync(join(repoRoot, "smartdocs/docs/raw"), { recursive: true });
    writeFileSync(join(repoRoot, "smartdocs/docs/raw/notes.md"), "# Existing", "utf-8");
    execFileSync("git", ["add", "smartdocs/docs/raw/notes.md"], { cwd: repoRoot });

    addTrackedFile(repoRoot, "scratch/notes.md", "# Incoming");

    const result = migrateDocs({ repoRoot, dryRun: false, migrationRunId: "test-migrate-live-002" });
    const migrated = result.results.filter((r) => r.classification === "migrated");
    expect(migrated).toHaveLength(1);
    expect(migrated[0].currentPath).toBe("smartdocs/docs/raw/notes-2.md");
    expect(existsSync(join(repoRoot, "smartdocs/docs/raw/notes-2.md"))).toBe(true);
  });
});
