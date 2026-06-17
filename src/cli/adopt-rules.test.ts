import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { generatePolarisRules } from "./adopt-rules.js";
import type { RepoScanInventory } from "./adoption-plan.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  };
});

const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

const baseInventory: RepoScanInventory = {
  scan_date: "2026-06-04T00:00:00.000Z",
  repo_state: "existing",
  package_manager: "npm",
  source_roots: ["src/"],
  docs_roots: ["docs/"],
  test_commands: ["npx vitest run"],
  build_commands: ["npm run build"],
  package_scripts: { test: "vitest run" },
  generated_roots: ["dist/"],
  cache_roots: [],
  fixture_roots: [],
  agent_instruction_files: [],
  existing_smartdocs_dirs: [],
  architecture_notes: ["TypeScript monorepo with CLI tooling"],
  likely_canonical_folders: ["src"],
  smartdocs_candidates: [],
  ignore_candidates: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedExistsSync.mockReturnValue(false);
  mockedReadFileSync.mockReturnValue("" as unknown as Buffer);
});

describe("generatePolarisRules", () => {
  it("writes POLARIS_RULES.md to repo root", async () => {
    await generatePolarisRules("/repo", baseInventory);
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/repo/POLARIS_RULES.md",
      expect.any(String),
      "utf-8",
    );
  });

  it("includes Temporary Worker Doctrine", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("Temporary Worker Doctrine");
    expect(content).toContain("Roles persist");
  });

  it("includes Repository Memory Doctrine", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("Repository Memory Doctrine");
    expect(content).toContain("repository artifacts");
  });

  it("includes Navigation Before Retrieval section", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("Navigation Before Retrieval");
    expect(content).toContain("Links are retrieval paths");
    expect(content).toContain("Never preload all linked documents");
    expect(content).toContain("Never load all doctrine");
    expect(content).toContain("Never load all charts");
  });

  it("includes map-query-only rule", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("polaris map query");
    expect(content).toContain("file-routes.json");
  });

  it("includes CLUSTER-ID notation, not POL-###", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("CLUSTER-ID");
    expect(content).not.toMatch(/POL-###/);
  });

  it("includes link to ROUTING.md", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain(".polaris/skills/ROUTING.md");
  });

  it("skips write if POLARIS_RULES.md already exists and overwrite is false", async () => {
    mockedExistsSync.mockReturnValue(true);
    await generatePolarisRules("/repo", baseInventory, { overwrite: false });
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("overwrites if POLARIS_RULES.md exists and overwrite is true", async () => {
    mockedExistsSync.mockReturnValue(true);
    await generatePolarisRules("/repo", baseInventory, { overwrite: true });
    expect(mockedWriteFileSync).toHaveBeenCalled();
  });

  it("includes architecture notes from inventory in repo overview", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("TypeScript monorepo with CLI tooling");
  });

  it("includes docs-review and docs-triage in skill command routing", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("docs-review");
    expect(content).toContain("docs-triage");
  });

  it("includes graph navigation guidance with Polaris graph as primary", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("Graph Navigation");
    expect(content).toContain("polaris graph build");
    expect(content).toContain("polaris graph query");
    expect(content).toContain("polaris graph impact");
    expect(content).toContain("Never prefer an external repo-analysis tool");
  });
});

describe("generatePolarisRules (template path)", () => {
  const FAKE_TEMPLATE =
    "# Polaris Rules\n\n## Repository Overview\n\n{{REPO_OVERVIEW}}\n\n## Skill Command Routing\n\nSee ROUTING.md\n\n## Graph Navigation\n\npolaris graph build\n\n## Runtime Boundaries\n\n- Execute only assigned child\n";

  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadFileSync.mockReturnValue("" as unknown as Buffer);
  });

  it("uses template when workspaceDir is provided and template exists", async () => {
    // existsSync: output path missing, template present
    mockedExistsSync.mockImplementation((p) => {
      return String(p).endsWith("POLARIS_RULES.md") && String(p).includes("/workspace/");
    });
    mockedReadFileSync.mockReturnValue(FAKE_TEMPLATE as unknown as Buffer);

    await generatePolarisRules("/repo", baseInventory, { workspaceDir: "/workspace" });

    expect(mockedReadFileSync).toHaveBeenCalledWith("/workspace/POLARIS_RULES.md", "utf-8");
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("TypeScript monorepo with CLI tooling");
    expect(content).not.toContain("{{REPO_OVERVIEW}}");
  });

  it("falls back to inline when workspaceDir template is missing", async () => {
    mockedExistsSync.mockReturnValue(false);

    await generatePolarisRules("/repo", baseInventory, { workspaceDir: "/workspace" });

    expect(mockedReadFileSync).not.toHaveBeenCalled();
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("Temporary Worker Doctrine");
  });

  it("template substitution replaces {{REPO_OVERVIEW}} with computed overview", async () => {
    mockedExistsSync.mockImplementation((p) => {
      return String(p).endsWith("POLARIS_RULES.md") && String(p).includes("/workspace/");
    });
    mockedReadFileSync.mockReturnValue(FAKE_TEMPLATE as unknown as Buffer);

    await generatePolarisRules("/repo", baseInventory, { workspaceDir: "/workspace" });

    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).not.toContain("{{REPO_OVERVIEW}}");
    expect(content).toContain("TypeScript monorepo with CLI tooling");
  });
});
