import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { runAdoptPhase } from "./adopt-command.js";
import type { RepoScanInventory } from "./adoption-plan.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "polaris-adopt-test-"));
  mkdirSync(join(root, ".polaris"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-repo", version: "0.0.1" }));
  return root;
}

const minimalInventory: RepoScanInventory = {
  scan_date: "2026-06-12T00:00:00.000Z",
  repo_state: "existing",
  package_manager: "npm",
  source_roots: ["src/"],
  docs_roots: [],
  test_commands: [],
  build_commands: [],
  package_scripts: {},
  generated_roots: [],
  cache_roots: [],
  fixture_roots: [],
  agent_instruction_files: [],
  existing_smartdocs_dirs: [],
  architecture_notes: [],
  likely_canonical_folders: [],
  smartdocs_candidates: [],
  ignore_candidates: [],
};

describe("adopt-command", () => {
  it("phase=rules creates POLARIS_RULES.md", async () => {
    const root = makeRoot();
    await runAdoptPhase("rules", root, { inventory: minimalInventory });
    expect(existsSync(join(root, "POLARIS_RULES.md"))).toBe(true);
  });

  it("throws on unknown phase name", async () => {
    const root = makeRoot();
    await expect(runAdoptPhase("unknown-phase" as never, root, {})).rejects.toThrow("Unknown adopt phase");
  });
});
