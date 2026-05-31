import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import {
  generateAdoptionPlan,
  generateAdoptionPlanArtifacts,
  type RepoScanInventory,
} from "./adoption-plan.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

const mockedMkdirSync = vi.mocked(fs.mkdirSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

const inventoryFixture: RepoScanInventory = {
  scan_date: "2026-05-31T00:00:00.000Z",
  repo_state: "existing",
  package_manager: "npm",
  source_roots: ["src/"],
  docs_roots: ["docs/"],
  test_commands: ["npm test"],
  build_commands: ["npm run build"],
  package_scripts: { test: "vitest run" },
  generated_roots: ["dist/"],
  cache_roots: [".turbo/"],
  fixture_roots: ["test/fixtures/"],
  agent_instruction_files: [
    {
      path: "AGENTS.md",
      provider: "openai",
      size_bytes: 1200,
      has_polaris_delegation: false,
      recommendation: "migrate",
      reason: "Contains repo-specific guidance that should be preserved.",
    },
    {
      path: "CLAUDE.md",
      provider: "claude",
      size_bytes: 120,
      has_polaris_delegation: true,
      recommendation: "preserve",
      reason: "Already delegated to Polaris.",
    },
  ],
  existing_smartdocs_dirs: [],
  architecture_notes: ["docs/adr/001.md"],
  likely_canonical_folders: ["src", "test/runtime/"],
  smartdocs_candidates: [
    {
      path: "docs/design.md",
      kind: "architecture",
      suggested_destination: "smartdocs/raw/design.md",
      confidence: 0.94,
      has_frontmatter: false,
      estimated_risk: "medium",
    },
  ],
  ignore_candidates: [".taskchain_artifacts/"],
};

describe("adoption-plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates an AdoptionPlan with ordered steps and impact summary", () => {
    const plan = generateAdoptionPlan(inventoryFixture, {
      now: new Date("2026-05-31T12:34:56.000Z"),
    });

    expect(plan.plan_id).toBe("adoption-2026-05-31T12-34-56.000Z");
    expect(plan.repo_state).toBe("existing");
    expect(plan.approved).toBe(false);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0]).toMatchObject({
      step_id: "provider-config-lock",
      order: 1,
      phase: "A",
    });
    expect(
      plan.steps.find(
        (step) =>
          step.category === "smartdocs-migrate" &&
          step.source_path === "docs/design.md" &&
          step.dest_path === "smartdocs/raw/design.md",
      ),
    ).toBeDefined();
    expect(plan.impact_summary).toMatchObject({
      files_to_move: 1,
      instruction_files_affected: 1,
      smartdocs_candidates_moved: 1,
      cognition_files_to_generate: 4,
    });
  });

  it("supports dry-run artifact generation without writing files", () => {
    const artifacts = generateAdoptionPlanArtifacts("/repo", inventoryFixture, {
      dryRun: true,
      now: new Date("2026-05-31T12:34:56.000Z"),
    });

    expect(artifacts.wroteFiles).toBe(false);
    expect(mockedMkdirSync).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(artifacts.jsonPath).toBe("/repo/.polaris/adoption-plan.json");
    expect(artifacts.markdownPath).toBe("/repo/.polaris/adoption-plan.md");
    expect(artifacts.markdown).toContain("# Adoption Plan");
  });

  it("writes JSON and Markdown artifacts when dry-run is false", () => {
    const artifacts = generateAdoptionPlanArtifacts("/repo", inventoryFixture, {
      dryRun: false,
      now: new Date("2026-05-31T12:34:56.000Z"),
    });

    expect(artifacts.wroteFiles).toBe(true);
    expect(mockedMkdirSync).toHaveBeenCalledWith("/repo/.polaris", { recursive: true });
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(2);
    expect(mockedWriteFileSync).toHaveBeenNthCalledWith(
      1,
      "/repo/.polaris/adoption-plan.json",
      expect.stringContaining("\"plan_id\": \"adoption-2026-05-31T12-34-56.000Z\""),
      "utf-8",
    );
    expect(mockedWriteFileSync).toHaveBeenNthCalledWith(
      2,
      "/repo/.polaris/adoption-plan.md",
      expect.stringContaining("| Order | Phase | Category | Action |"),
      "utf-8",
    );
  });
});
