import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { runInit } from "./init.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
const mockedMkdirSync = vi.mocked(fs.mkdirSync);
const mockedRenameSync = vi.mocked(fs.renameSync);

let stdoutOutput = "";
const originalWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  vi.resetAllMocks();
  stdoutOutput = "";
  vi.spyOn(process.stdout, "write").mockImplementation((data: unknown) => {
    stdoutOutput += String(data);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const REPO_ROOT = "/fake-repo";
const CONFIG_PATH = join(REPO_ROOT, "polaris.config.json");

describe("runInit — no existing config", () => {
  it("writes a new config with compactionProviders when providers are detected", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue(["caveman"]);

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const [path, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    expect(path).toBe(CONFIG_PATH);
    const written = JSON.parse(content) as Record<string, unknown>;
    expect(written).toMatchObject({
      version: "1.0",
      providers: { compactionProviders: ["caveman"] },
    });
  });

  it("writes config WITHOUT compactionProviders when no providers detected", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue([]);

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    expect(written).not.toHaveProperty("providers.compactionProviders");
  });

  it("includes both caveman and gitnexus when both detected", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue(["caveman", "gitnexus"]);

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    expect((written.providers as Record<string, unknown>).compactionProviders).toEqual([
      "caveman",
      "gitnexus",
    ]);
  });

  it("writes repoAnalysis.preferred when a repo-analysis provider is detected", () => {
    mockedExistsSync.mockReturnValue(false);
    const detectCompaction = vi.fn().mockReturnValue([]);
    const detectRepoAnalysis = vi.fn().mockReturnValue(["gitnexus"]);

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: detectCompaction,
      detectRepoAnalysisProviders: detectRepoAnalysis,
    });

    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    expect(written).toMatchObject({
      providers: { repoAnalysis: { preferred: "gitnexus" } },
    });
  });
});

describe("runInit — existing config", () => {
  it("preserves existing fields when merging", () => {
    const existingConfig = {
      version: "1.0",
      repo: { name: "my-repo" },
    };
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));
    const detect = vi.fn().mockReturnValue(["gitnexus"]);

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    expect(written).toMatchObject({
      version: "1.0",
      repo: { name: "my-repo" },
      providers: { compactionProviders: ["gitnexus"] },
    });
  });

  it("preserves existing providers.repoAnalysis while adding compactionProviders", () => {
    const existingConfig = {
      version: "1.0",
      providers: { repoAnalysis: { preferred: "polaris-map" } },
    };
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));
    const detect = vi.fn().mockReturnValue(["caveman"]);

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue(["gitnexus"]),
    });

    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    const providers = written.providers as Record<string, unknown>;
    expect(providers.repoAnalysis).toEqual({ preferred: "gitnexus" });
    expect(providers.compactionProviders).toEqual(["caveman"]);
  });

  it("preserves repoAnalysis fallback while omitting preferred when no repo-analysis provider is detected", () => {
    const existingConfig = {
      version: "1.0",
      providers: {
        repoAnalysis: { preferred: "gitnexus", fallback: ["polaris-map", "ripgrep"] },
      },
    };
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: vi.fn().mockReturnValue([]),
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    const providers = written.providers as Record<string, unknown>;
    expect(providers.repoAnalysis).toEqual({ fallback: ["polaris-map", "ripgrep"] });
  });

  it("removes compactionProviders from existing config when none detected", () => {
    const existingConfig = {
      version: "1.0",
      providers: { compactionProviders: ["caveman"] },
    };
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));
    const detect = vi.fn().mockReturnValue([]);

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    // providers key may be absent or present but without compactionProviders
    if ("providers" in written && written.providers !== undefined) {
      expect(written.providers).not.toHaveProperty("compactionProviders");
    }
  });
});

describe("runInit — dry-run", () => {
  it("does not write the file in dry-run mode", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue(["caveman"]);

    runInit({
      repoRoot: REPO_ROOT,
      dryRun: true,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("prints the JSON to stdout in dry-run mode", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue(["caveman"]);

    runInit({
      repoRoot: REPO_ROOT,
      dryRun: true,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      providers: { compactionProviders: ["caveman"] },
    });
  });
});

describe("runInit — repo state detection", () => {
  it("prints repository state and exits when --status is used", () => {
    runInit({
      repoRoot: REPO_ROOT,
      status: true,
      detectRepoState: vi.fn().mockReturnValue("partial"),
      detectProviders: vi.fn().mockReturnValue(["caveman"]),
      detectRepoAnalysisProviders: vi.fn().mockReturnValue(["gitnexus"]),
    });

    expect(stdoutOutput).toContain("Repository state: partial");
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("exits early with adoption guidance when repo state is existing", () => {
    runInit({
      repoRoot: REPO_ROOT,
      detectRepoState: vi.fn().mockReturnValue("existing"),
      detectProviders: vi.fn().mockReturnValue(["caveman"]),
      detectRepoAnalysisProviders: vi.fn().mockReturnValue(["gitnexus"]),
    });

    expect(stdoutOutput).toContain("Run `polaris init --adopt` to begin adoption.");
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("allows config generation for existing repos when --adopt is set", () => {
    mockedExistsSync.mockReturnValue(false);

    runInit({
      repoRoot: REPO_ROOT,
      adopt: true,
      yes: true,
      detectRepoState: vi.fn().mockReturnValue("existing"),
      detectProviders: vi.fn().mockReturnValue(["caveman"]),
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
      scanAdoptionInventory: vi.fn().mockReturnValue({
        scan_date: "2026-05-31T00:00:00.000Z",
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
        agent_instruction_files: [],
        existing_smartdocs_dirs: [],
        architecture_notes: [],
        likely_canonical_folders: [],
        smartdocs_candidates: [],
        ignore_candidates: [],
      }),
      generateAdoptionArtifacts: vi.fn().mockReturnValue({
        plan: {
          plan_id: "adoption-test",
          generated_at: "2026-05-31T00:00:00.000Z",
          repo_state: "existing",
          approved: false,
          approved_at: null,
          dry_run: false,
          steps: [],
          impact_summary: {
            files_to_create: 0,
            files_to_move: 0,
            files_to_modify: 0,
            instruction_files_affected: 0,
            smartdocs_candidates_moved: 0,
            cognition_files_to_generate: 0,
          },
        },
        json: "{}\n",
        markdown: "# Adoption Plan\n",
        jsonPath: "/fake-repo/.polaris/adoption-plan.json",
        markdownPath: "/fake-repo/.polaris/adoption-plan.md",
        wroteFiles: false,
      }),
    });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    expect(written).toMatchObject({
      execution: {
        adapter: "terminal-cli",
        rotation: [],
        allowCrossAgentFallback: false,
      },
      orchestration: {
        mode: "supervised",
      },
    });
    expect(stdoutOutput).toContain("Adoption approved. Proceeding with mutation phases.");
  });

  it("keeps existing execution metadata while applying adopt dispatch lock", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: "1.0",
        execution: {
          adapter: "custom-adapter",
          providers: { codex: { command: "codex" } },
          roles: { worker: { provider: "codex", model: "gpt-5.5" } },
          rotation: ["codex", "gemini"],
          allowCrossAgentFallback: true,
        },
        orchestration: {
          mode: "auto",
          auto_finalize: true,
        },
      }),
    );

    runInit({
      repoRoot: REPO_ROOT,
      adopt: true,
      yes: true,
      detectRepoState: vi.fn().mockReturnValue("existing"),
      detectProviders: vi.fn().mockReturnValue([]),
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
      scanAdoptionInventory: vi.fn().mockReturnValue({
        scan_date: "2026-05-31T00:00:00.000Z",
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
        agent_instruction_files: [],
        existing_smartdocs_dirs: [],
        architecture_notes: [],
        likely_canonical_folders: [],
        smartdocs_candidates: [],
        ignore_candidates: [],
      }),
      generateAdoptionArtifacts: vi.fn().mockReturnValue({
        plan: {
          plan_id: "adoption-test",
          generated_at: "2026-05-31T00:00:00.000Z",
          repo_state: "existing",
          approved: false,
          approved_at: null,
          dry_run: false,
          steps: [],
          impact_summary: {
            files_to_create: 0,
            files_to_move: 0,
            files_to_modify: 0,
            instruction_files_affected: 0,
            smartdocs_candidates_moved: 0,
            cognition_files_to_generate: 0,
          },
        },
        json: "{}\n",
        markdown: "# Adoption Plan\n",
        jsonPath: "/fake-repo/.polaris/adoption-plan.json",
        markdownPath: "/fake-repo/.polaris/adoption-plan.md",
        wroteFiles: false,
      }),
    });

    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    expect(written).toMatchObject({
      execution: {
        adapter: "terminal-cli",
        providers: { codex: { command: "codex" } },
        roles: { worker: { provider: "codex", model: "gpt-5.5" } },
        rotation: [],
        allowCrossAgentFallback: false,
      },
      orchestration: {
        mode: "supervised",
        auto_finalize: true,
      },
    });
  });
});

describe("runInit — stdout messaging", () => {
  it("prints detected providers in success message", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue(["caveman", "gitnexus"]);

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    expect(stdoutOutput).toContain("caveman");
    expect(stdoutOutput).toContain("gitnexus");
  });

  it("reports no providers when none detected", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue([]);

    runInit({
      repoRoot: REPO_ROOT,
      detectProviders: detect,
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
    });

    expect(stdoutOutput).toContain("No compaction providers detected");
  });
});

describe("runInit — adopt approval gate", () => {
  it("aborts adoption when approval is denied", () => {
    mockedExistsSync.mockReturnValue(false);
    const generateAdoptionArtifacts = vi.fn().mockReturnValue({
      plan: {
        plan_id: "adoption-test",
        generated_at: "2026-05-31T00:00:00.000Z",
        repo_state: "existing",
        approved: false,
        approved_at: null,
        dry_run: false,
        steps: [],
        impact_summary: {
          files_to_create: 0,
          files_to_move: 0,
          files_to_modify: 0,
          instruction_files_affected: 0,
          smartdocs_candidates_moved: 0,
          cognition_files_to_generate: 0,
        },
      },
      json: "{}\n",
      markdown: "# Adoption Plan\n",
      jsonPath: "/fake-repo/.polaris/adoption-plan.json",
      markdownPath: "/fake-repo/.polaris/adoption-plan.md",
      wroteFiles: false,
    });

    runInit({
      repoRoot: REPO_ROOT,
      adopt: true,
      detectProviders: vi.fn().mockReturnValue([]),
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
      scanAdoptionInventory: vi.fn().mockReturnValue({
        scan_date: "2026-05-31T00:00:00.000Z",
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
        agent_instruction_files: [],
        existing_smartdocs_dirs: [],
        architecture_notes: [],
        likely_canonical_folders: [],
        smartdocs_candidates: [],
        ignore_candidates: [],
      }),
      generateAdoptionArtifacts,
      readAdoptionApproval: vi.fn().mockReturnValue(false),
    });

    expect(generateAdoptionArtifacts).toHaveBeenCalledOnce();
    expect(stdoutOutput).toContain("# Adoption Plan");
    expect(stdoutOutput).toContain("Adoption aborted: explicit approval required.");
    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
  });

  it("bypasses prompt and proceeds when --yes is set", () => {
    mockedExistsSync.mockReturnValue(false);
    const readAdoptionApproval = vi.fn();

    runInit({
      repoRoot: REPO_ROOT,
      adopt: true,
      yes: true,
      detectProviders: vi.fn().mockReturnValue([]),
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
      scanAdoptionInventory: vi.fn().mockReturnValue({
        scan_date: "2026-05-31T00:00:00.000Z",
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
        agent_instruction_files: [],
        existing_smartdocs_dirs: [],
        architecture_notes: [],
        likely_canonical_folders: [],
        smartdocs_candidates: [],
        ignore_candidates: [],
      }),
      generateAdoptionArtifacts: vi.fn().mockReturnValue({
        plan: {
          plan_id: "adoption-test",
          generated_at: "2026-05-31T00:00:00.000Z",
          repo_state: "existing",
          approved: false,
          approved_at: null,
          dry_run: false,
          steps: [],
          impact_summary: {
            files_to_create: 0,
            files_to_move: 0,
            files_to_modify: 0,
            instruction_files_affected: 0,
            smartdocs_candidates_moved: 0,
            cognition_files_to_generate: 0,
          },
        },
        json: "{}\n",
        markdown: "# Adoption Plan\n",
        jsonPath: "/fake-repo/.polaris/adoption-plan.json",
        markdownPath: "/fake-repo/.polaris/adoption-plan.md",
        wroteFiles: false,
      }),
      readAdoptionApproval,
    });

    expect(readAdoptionApproval).not.toHaveBeenCalled();
    expect(stdoutOutput).toContain("Adoption approved. Proceeding with mutation phases.");
  });

  it("runs SmartDocs migration step during adopt flow", () => {
    mockedExistsSync.mockImplementation((path: fs.PathLike) => {
      const value = String(path);
      if (value === CONFIG_PATH) {
        return false;
      }
      if (value === join(REPO_ROOT, "docs/design.md")) {
        return true;
      }
      return false;
    });

    runInit({
      repoRoot: REPO_ROOT,
      adopt: true,
      yes: true,
      detectRepoState: vi.fn().mockReturnValue("existing"),
      detectProviders: vi.fn().mockReturnValue([]),
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
      scanAdoptionInventory: vi.fn().mockReturnValue({
        scan_date: "2026-05-31T00:00:00.000Z",
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
        agent_instruction_files: [],
        existing_smartdocs_dirs: [],
        architecture_notes: [],
        likely_canonical_folders: [],
        smartdocs_candidates: [
          {
            path: "docs/design.md",
            kind: "architecture",
            suggested_destination: "smartdocs/raw/design.md",
            confidence: 0.95,
            has_frontmatter: false,
            estimated_risk: "medium",
          },
        ],
        ignore_candidates: [],
      }),
      generateAdoptionArtifacts: vi.fn().mockReturnValue({
        plan: {
          plan_id: "adoption-test",
          generated_at: "2026-05-31T00:00:00.000Z",
          repo_state: "existing",
          approved: false,
          approved_at: null,
          dry_run: false,
          steps: [],
          impact_summary: {
            files_to_create: 0,
            files_to_move: 1,
            files_to_modify: 0,
            instruction_files_affected: 0,
            smartdocs_candidates_moved: 1,
            cognition_files_to_generate: 0,
          },
        },
        json: "{}\n",
        markdown: "# Adoption Plan\n",
        jsonPath: "/fake-repo/.polaris/adoption-plan.json",
        markdownPath: "/fake-repo/.polaris/adoption-plan.md",
        wroteFiles: false,
      }),
    });

    expect(mockedMkdirSync).toHaveBeenCalledWith(join(REPO_ROOT, "smartdocs/raw"), {
      recursive: true,
    });
    expect(mockedRenameSync).toHaveBeenCalledWith(
      join(REPO_ROOT, "docs/design.md"),
      join(REPO_ROOT, "smartdocs/raw/design.md"),
    );
    expect(stdoutOutput).toContain("SmartDocs migration step completed: moved 1, skipped 0.");
  });
});
