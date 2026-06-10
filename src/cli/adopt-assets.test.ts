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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWorkspaceAssets, isThinPointer, runGraphBuild } from "./adopt-assets.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";

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

describe("isThinPointer", () => {
  it("Test 1: returns true for a classic thin pointer with POLARIS.md reference", () => {
    const content = "# Agent Instructions\n\nRead [POLARIS.md](POLARIS.md) before beginning any work.\n";
    expect(isThinPointer(content)).toBe(true);
  });

  it("Test 2: returns false when no POLARIS.md reference", () => {
    const content = "# My rules\n\nAlways use TypeScript.\n";
    expect(isThinPointer(content)).toBe(false);
  });

  it("Test 3: returns false when more than 3 meaningful lines (even with POLARIS.md)", () => {
    const content = "# Agent Instructions\nRead POLARIS.md before beginning any work.\nAlso: always lint before committing.\nUse conventional commits.\nNever push to main directly.\n";
    expect(isThinPointer(content)).toBe(false);
  });

  it("Test 4: returns true when blank lines and HTML comment lines are ignored", () => {
    const content = "\n<!-- genesis doctrine archived: smartdocs/doctrine/active/2026-06-09-genesis-agent-doctrine.md -->\n\nRead [POLARIS.md](POLARIS.md) before beginning any work.\n";
    expect(isThinPointer(content)).toBe(true);
  });

  it("Test 5: returns false with more than 3 meaningful lines even with POLARIS.md present", () => {
    const content = "Read POLARIS.md before beginning any work.\nAlways use TypeScript strict mode.\nRun tests before committing.\nUse pnpm not npm.\n";
    expect(isThinPointer(content)).toBe(false);
  });
});

describe("runGraphBuild", () => {
  it("Test 1: returns graph-success when spawnSync returns status 0 with stdout", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "Symbols: 142",
      stderr: "",
      pid: 1234,
      output: ["Symbols: 142"],
      signal: null,
    });

    const result = runGraphBuild("/repo");

    expect(result.status).toBe("graph-success");
    expect(result.stdout).toBe("Symbols: 142");
    expect(result.reason).toBeUndefined();
    expect(result.followUpCommand).toBeUndefined();
  });

  it("Test 2: returns graph-failed with reason when spawnSync returns status 1 with stderr", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Tree-sitter bindings not found",
      pid: 1234,
      output: ["", "Tree-sitter bindings not found"],
      signal: null,
    });

    const result = runGraphBuild("/repo");

    expect(result.status).toBe("graph-failed");
    expect(result.reason).toBe("Tree-sitter bindings not found");
    expect(result.followUpCommand).toBe("polaris-cli graph build");
    expect(result.stdout).toBeUndefined();
  });

  it("Test 3: returns graph-failed when spawnSync throws ENOENT error", () => {
    const error = new Error("ENOENT");
    vi.mocked(spawnSync).mockImplementation(() => {
      throw error;
    });

    const result = runGraphBuild("/repo");

    expect(result.status).toBe("graph-failed");
    expect(result.reason).toBe("ENOENT");
    expect(result.followUpCommand).toBe("polaris-cli graph build");
  });
});
