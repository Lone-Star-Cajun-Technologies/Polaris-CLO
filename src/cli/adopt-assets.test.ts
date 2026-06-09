import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installWorkspaceAssets } from "./adopt-assets.js";

function makeFakeWorkspace(dir: string): void {
  // Skills
  const skillDir = join(dir, ".polaris", "skills", "polaris-run");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# polaris-run", "utf-8");

  // Roles
  const rolesDir = join(dir, ".polaris", "roles");
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, "worker.md"), "# worker", "utf-8");

  // Smartdocs
  const doctrineActive = join(dir, "smartdocs", "doctrine", "active");
  mkdirSync(doctrineActive, { recursive: true });
  writeFileSync(join(doctrineActive, ".gitkeep"), "", "utf-8");

  const architecture = join(dir, "smartdocs", "architecture");
  mkdirSync(architecture, { recursive: true });
  writeFileSync(join(architecture, ".gitkeep"), "", "utf-8");
}

describe("installWorkspaceAssets", () => {
  let repoRoot: string;
  let workspaceDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "polaris-repo-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "polaris-ws-"));
    makeFakeWorkspace(workspaceDir);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("Test 1: installs all assets into an empty repo", () => {
    const result = installWorkspaceAssets(repoRoot, workspaceDir);

expect(result.installed.length).toBeGreaterThan(0);
    expect(result.alreadyPresent).toHaveLength(0);

    // Skill file should exist
    expect(existsSync(join(repoRoot, ".polaris", "skills", "polaris-run", "SKILL.md"))).toBe(true);
    // Role file should exist
    expect(existsSync(join(repoRoot, ".polaris", "roles", "worker.md"))).toBe(true);
    // Smartdocs scaffold
    expect(existsSync(join(repoRoot, "smartdocs", "architecture"))).toBe(true);
  });

  it("Test 2: re-run marks existing skill dir as alreadyPresent and does not overwrite", () => {
    // First install
    installWorkspaceAssets(repoRoot, workspaceDir);

    // Write a sentinel to the skill file
    const skillFile = join(repoRoot, ".polaris", "skills", "polaris-run", "SKILL.md");
    writeFileSync(skillFile, "SENTINEL", "utf-8");

    // Second install
    const result = installWorkspaceAssets(repoRoot, workspaceDir);

    expect(result.alreadyPresent).toContain(".polaris/skills/polaris-run");
    // Sentinel must not be overwritten
    expect(readFileSync(skillFile, "utf-8")).toBe("SENTINEL");
  });

  it("Test 3: symlink at .polaris/roles causes roles to be skipped", () => {
    // Create a real dir to symlink to
    const realRolesDir = mkdtempSync(join(tmpdir(), "polaris-roles-real-"));

    try {
      // Create .polaris dir first
      mkdirSync(join(repoRoot, ".polaris"), { recursive: true });
      symlinkSync(realRolesDir, join(repoRoot, ".polaris", "roles"));
    } catch {
      // symlinkSync not supported in this environment — known limitation
      rmSync(realRolesDir, { recursive: true, force: true });
      return;
    }

    const result = installWorkspaceAssets(repoRoot, workspaceDir);

    // All role paths should be in skipped
    const roleSkipped = result.skipped.filter((p) => p.startsWith(".polaris/roles/"));
    expect(roleSkipped.length).toBeGreaterThan(0);

    rmSync(realRolesDir, { recursive: true, force: true });
  });
});
