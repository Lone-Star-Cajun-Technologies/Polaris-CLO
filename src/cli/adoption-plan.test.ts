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

  it("writes plan artifacts for dry-run generation", () => {
    const artifacts = generateAdoptionPlanArtifacts("/repo", inventoryFixture, {
      dryRun: true,
      now: new Date("2026-05-31T12:34:56.000Z"),
    });

    expect(artifacts.plan.dry_run).toBe(true);
    expect(artifacts.wroteFiles).toBe(true);
    expect(mockedMkdirSync).toHaveBeenCalledWith("/repo/.polaris", { recursive: true });
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(2);
    expect(artifacts.jsonPath).toBe("/repo/.polaris/adoption-plan.json");
    expect(artifacts.markdownPath).toBe("/repo/.polaris/adoption-plan.md");
    expect(artifacts.markdown).toContain("# Adoption Plan");
    expect(artifacts.markdown).toContain("| Metric | Value |");
    expect(artifacts.markdown).toContain("## Phase A");
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
      expect.stringContaining("| Metric | Value |"),
      "utf-8",
    );
  });
});

describe("generateAdoptionPlan — workspace-root-surfaces step", () => {
  const BASE_INVENTORY: RepoScanInventory = {
    scan_date: "2026-06-09T00:00:00.000Z",
    repo_state: "existing",
    package_manager: null,
    source_roots: [],
    docs_roots: [],
    test_commands: [],
    build_commands: [],
    package_scripts: {},
    generated_roots: [],
    cache_roots: [],
    fixture_roots: [],
    existing_smartdocs_dirs: [],
    architecture_notes: [],
    likely_canonical_folders: [],
    smartdocs_candidates: [],
    ignore_candidates: [],
    agent_instruction_files: [],
  };

  it("always includes a workspace-root-surfaces step in Phase A", () => {
    const plan = generateAdoptionPlan(BASE_INVENTORY);

    const step = plan.steps.find((s) => s.step_id === "workspace-root-surfaces");
    expect(step).toBeDefined();
    expect(step!.phase).toBe("A");
    expect(step!.category).toBe("scaffold");
    expect(step!.estimated_risk).toBe("low");
    expect(step!.destructive).toBe(false);
    expect(step!.requires_approval).toBe(false);
    expect(step!.dest_path).toContain("CLAUDE.md");
    expect(step!.dest_path).toContain("AGENTS.md");
    expect(step!.dest_path).toContain(".github/copilot-instructions.md");
  });

  it("workspace-root-surfaces step appears before all Phase C steps", () => {
    const inventory: RepoScanInventory = {
      ...BASE_INVENTORY,
      smartdocs_candidates: [
        {
          path: "docs/design.md",
          kind: "architecture",
          suggested_destination: "smartdocs/raw/design.md",
          confidence: 0.9,
          has_frontmatter: false,
          estimated_risk: "medium",
        },
      ],
    };

    const plan = generateAdoptionPlan(inventory);

    const surfaceStep = plan.steps.find((s) => s.step_id === "workspace-root-surfaces");
    expect(surfaceStep).toBeDefined();
    const surfaceOrder = surfaceStep!.order;
    const phaseCOrders = plan.steps
      .filter((s) => s.phase === "C")
      .map((s) => s.order);

    expect(phaseCOrders.length).toBeGreaterThan(0);
    expect(phaseCOrders.every((o) => o > surfaceOrder)).toBe(true);
  });
});
