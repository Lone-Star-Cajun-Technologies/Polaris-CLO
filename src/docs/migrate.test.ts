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

  it("allows anything under docs/", () => {
    expect(isAllowedException("docs/spec/foo.md").allowed).toBe(true);
    expect(isAllowedException("docs/raw/bar.md").allowed).toBe(true);
  });

  it("allows anything under .agents/, .codex/, .claude/, .taskchain_artifacts/", () => {
    expect(isAllowedException(".agents/instructions.md").allowed).toBe(true);
    expect(isAllowedException(".codex/skills/foo/SKILL.md").allowed).toBe(true);
    expect(isAllowedException(".claude/CLAUDE.md").allowed).toBe(true);
    expect(isAllowedException(".taskchain_artifacts/run/notes.md").allowed).toBe(true);
  });

  it("does NOT allow arbitrary markdown files", () => {
    expect(isAllowedException("src/some-feature/NOTES.md").allowed).toBe(false);
    expect(isAllowedException("planning/ideas.md").allowed).toBe(false);
    expect(isAllowedException("scratch.md").allowed).toBe(false);
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

    expect(migrated).toHaveLength(1);
    expect(migrated[0].originalPath).toBe("planning/ideas.md");
    expect(migrated[0].destination).toBe("docs/raw/ideas.md");

    expect(exceptions.length).toBeGreaterThanOrEqual(2);

    // File must NOT have been moved
    expect(existsSync(join(repoRoot, "planning/ideas.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "docs/raw/ideas.md"))).toBe(false);

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

  it("moves files to docs/raw/, writes provenance JSON", () => {
    addTrackedFile(repoRoot, "README.md");
    addTrackedFile(repoRoot, "scratch/notes.md", "# Notes");

    const result = migrateDocs({ repoRoot, dryRun: false, migrationRunId: "test-migrate-live-001" });

    expect(result.dryRun).toBe(false);

    const migrated = result.results.filter((r) => r.classification === "migrated");
    expect(migrated).toHaveLength(1);
    expect(migrated[0].originalPath).toBe("scratch/notes.md");
    expect(migrated[0].currentPath).toBe("docs/raw/notes.md");

    // File should now exist in docs/raw/
    expect(existsSync(join(repoRoot, "docs/raw/notes.md"))).toBe(true);
    // File should no longer exist at original location
    expect(existsSync(join(repoRoot, "scratch/notes.md"))).toBe(false);

    // Provenance written
    expect(result.provenancePath).not.toBeNull();
    const provContent = JSON.parse(
      readFileSync(join(repoRoot, result.provenancePath!), "utf-8"),
    ) as Array<{ originalPath: string; currentPath: string; migratedAt: string; migrationRunId: string }>;
    expect(provContent).toHaveLength(1);
    expect(provContent[0].originalPath).toBe("scratch/notes.md");
    expect(provContent[0].currentPath).toBe("docs/raw/notes.md");
    expect(provContent[0].migrationRunId).toBe("test-migrate-live-001");
    expect(provContent[0].migratedAt).toBeTruthy();
  });

  it("handles filename collisions by uniquifying destination", () => {
    mkdirSync(join(repoRoot, "docs/raw"), { recursive: true });
    writeFileSync(join(repoRoot, "docs/raw/notes.md"), "# Existing", "utf-8");
    execFileSync("git", ["add", "docs/raw/notes.md"], { cwd: repoRoot });

    addTrackedFile(repoRoot, "scratch/notes.md", "# Incoming");

    const result = migrateDocs({ repoRoot, dryRun: false, migrationRunId: "test-migrate-live-002" });
    const migrated = result.results.filter((r) => r.classification === "migrated");
    expect(migrated).toHaveLength(1);
    expect(migrated[0].currentPath).toBe("docs/raw/notes-2.md");
    expect(existsSync(join(repoRoot, "docs/raw/notes-2.md"))).toBe(true);
  });
});
