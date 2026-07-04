/**
 * Fixture validation for the `.polaris/adoption-inventory.json` snapshot
 * updated by this PR. Unlike `adoption-inventory.test.ts`, which exercises
 * `scanAdoptionInventory()` against synthetic fixture repos, this file pins
 * down the specific fields that changed in the checked-in inventory snapshot
 * itself: the updated build script, new SmartDocs tmp-dir entries, new agent
 * instruction spec references, and new SmartDocs candidates for the Codex
 * plugin skill wrappers this PR adds.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoScanInventory } from "./adoption-plan.js";

const repoRoot = process.cwd();

function readInventory(): RepoScanInventory {
  const inventoryPath = join(repoRoot, ".polaris", "adoption-inventory.json");
  return JSON.parse(readFileSync(inventoryPath, "utf8")) as RepoScanInventory;
}

describe(".polaris/adoption-inventory.json fixture", () => {
  const inventory = readInventory();

  it("conforms to the RepoScanInventory shape's required top-level fields", () => {
    expect(inventory.repo_state).toBe("polaris-enabled");
    expect(inventory.package_manager).toBe("npm");
    expect(Array.isArray(inventory.source_roots)).toBe(true);
    expect(Array.isArray(inventory.smartdocs_candidates)).toBe(true);
    expect(Array.isArray(inventory.agent_instruction_files)).toBe(true);
  });

  it("updates the build script to also stage the polaris-tools helper into dist/workspace", () => {
    expect(inventory.package_scripts.build).toBe(
      "tsc && rm -rf dist/workspace && cp -r src/workspace dist/workspace && " +
        "cp .codex/plugins/polaris/skills/polaris-tools/tools.js dist/workspace/.polaris/skills/polaris-tools/tools.js",
    );
  });

  it("records the new Google Drive sync tmp directories under smartdocs/", () => {
    expect(inventory.existing_smartdocs_dirs).toContain("smartdocs/.tmp.drivedownload/");
    expect(inventory.existing_smartdocs_dirs).toContain("smartdocs/.tmp.driveupload/");
  });

  it("references the newly added interactive-governance design specs as architecture notes", () => {
    expect(inventory.architecture_notes).toContain(
      "docs/superpowers/specs/2026-06-11-interactive-governance-smartdocs-ingest-design.md",
    );
    expect(inventory.architecture_notes).toContain("docs/superpowers/specs/2026-06-12-polaris-docs-review-design.md");
    expect(inventory.architecture_notes).toContain("docs/superpowers/specs/2026-06-13-polaris-docs-triage-design.md");
  });

  it("adds a high-confidence SmartDocs candidate for every new Codex plugin skill's SKILL.md", () => {
    const newSkillSkillMdPaths = [
      ".codex/plugins/polaris/skills/docs-ingest/SKILL.md",
      ".codex/plugins/polaris/skills/docs-promote/SKILL.md",
      ".codex/plugins/polaris/skills/polaris-analyze/SKILL.md",
      ".codex/plugins/polaris/skills/polaris-catalog/SKILL.md",
      ".codex/plugins/polaris/skills/polaris-finalize/SKILL.md",
      ".codex/plugins/polaris/skills/polaris-reconcile/SKILL.md",
      ".codex/plugins/polaris/skills/polaris-run/SKILL.md",
    ];

    for (const skillMdPath of newSkillSkillMdPaths) {
      const candidate = inventory.smartdocs_candidates.find((c) => c.path === skillMdPath);
      expect(candidate, `expected a smartdocs candidate for ${skillMdPath}`).toBeDefined();
      expect(candidate?.kind).toBe("doc");
      expect(candidate?.has_frontmatter).toBe(true);
      expect(candidate?.estimated_risk).toBe("low");
      expect(candidate?.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("adds low-confidence doc candidates for the new .claude/commands/polaris-* shims", () => {
    const claudeCommandPaths = [
      ".claude/commands/polaris-adopt.md",
      ".claude/commands/polaris-analyze.md",
      ".claude/commands/polaris-init.md",
      ".claude/commands/polaris-reconcile.md",
      ".claude/commands/polaris-run.md",
      ".claude/commands/polaris-status.md",
    ];

    for (const commandPath of claudeCommandPaths) {
      const candidate = inventory.smartdocs_candidates.find((c) => c.path === commandPath);
      expect(candidate, `expected a smartdocs candidate for ${commandPath}`).toBeDefined();
      expect(candidate?.has_frontmatter).toBe(false);
      expect(candidate?.confidence).toBeCloseTo(0.7);
    }
  });

  it("does not contain duplicate smartdocs_candidates paths", () => {
    const paths = inventory.smartdocs_candidates.map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});