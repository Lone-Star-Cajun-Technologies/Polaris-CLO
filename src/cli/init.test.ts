import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as child_process from "node:child_process";
import { join } from "node:path";
import { finalizeAdoption, isBeyondSymlink, runInit } from "./init.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    lstatSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedLstatSync = vi.mocked(fs.lstatSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
const mockedAppendFileSync = vi.mocked(fs.appendFileSync);
const mockedMkdirSync = vi.mocked(fs.mkdirSync);
const mockedRenameSync = vi.mocked(fs.renameSync);
const mockedExecFileSync = vi.mocked(child_process.execFileSync);

let stdoutOutput = "";
const originalWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  vi.resetAllMocks();
  stdoutOutput = "";
  mockedExecFileSync.mockReturnValue("");
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
      scaffoldRootSurfaces: vi.fn().mockReturnValue({ created: [], skipped: [] }),
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

    const configWrite = mockedWriteFileSync.mock.calls.find(([path]) => path === CONFIG_PATH);
    const planWrite = mockedWriteFileSync.mock.calls.find(
      ([path]) => path === join(REPO_ROOT, ".polaris", "adoption-plan.json"),
    );
    expect(configWrite).toBeDefined();
    expect(planWrite).toBeDefined();
    const [, content] = configWrite as [string, string, string];
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
    expect(JSON.parse((planWrite as [string, string, string])[1])).toMatchObject({
      approved: true,
      plan_id: "adoption-test",
    });
    expect(stdoutOutput).toContain("Adoption approval bypassed via --yes.");
    expect(stdoutOutput).toContain("Adoption changes staged.");
  });

  it("prints the adoption plan and skips mutations in dry-run adopt mode", () => {
    mockedExistsSync.mockReturnValue(false);

    const generateAdoptionArtifacts = vi.fn().mockReturnValue({
      plan: {
        plan_id: "adoption-test",
        generated_at: "2026-05-31T00:00:00.000Z",
        repo_state: "existing",
        approved: false,
        approved_at: null,
        dry_run: true,
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
      markdown: "# Adoption Plan\n## Phase A\n",
      jsonPath: "/fake-repo/.polaris/adoption-plan.json",
      markdownPath: "/fake-repo/.polaris/adoption-plan.md",
      wroteFiles: true,
    });

    runInit({
      repoRoot: REPO_ROOT,
      adopt: true,
      dryRun: true,
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
      generateAdoptionArtifacts,
    });

    expect(generateAdoptionArtifacts).toHaveBeenCalledWith(
      REPO_ROOT,
      expect.any(Object),
      expect.objectContaining({ dryRun: true }),
    );
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(stdoutOutput).toContain("# Adoption Plan");
    expect(stdoutOutput).toContain("Adoption dry run: Phase C writes skipped.");
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

  it("skips writing when the adoption lock is already present", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: "1.0",
        execution: {
          adapter: "terminal-cli",
          rotation: [],
          allowCrossAgentFallback: false,
        },
        orchestration: {
          mode: "supervised",
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

    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockedWriteFileSync.mock.calls[0]?.[0]).toBe(
      join(REPO_ROOT, ".polaris", "adoption-plan.json"),
    );
    expect(JSON.parse(mockedWriteFileSync.mock.calls[0]?.[1] as string)).toMatchObject({
      approved: true,
      plan_id: "adoption-test",
    });
    expect(stdoutOutput).toContain("Provider config already locked — skipping.");
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
      scaffoldRootSurfaces: vi.fn().mockReturnValue({ created: [], skipped: [] }),
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
      scaffoldRootSurfaces: vi.fn().mockReturnValue({ created: [], skipped: [] }),
    });

    expect(readAdoptionApproval).not.toHaveBeenCalled();
    expect(mockedAppendFileSync).toHaveBeenCalledOnce();
    const [telemetryPath, telemetryContent] = mockedAppendFileSync.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(telemetryPath).toBe(join(REPO_ROOT, ".polaris", "adoption-telemetry.jsonl"));
    expect(JSON.parse(telemetryContent)).toMatchObject({
      event: "adoption-approval-bypassed",
      run_mode: "yes",
      plan_id: "adoption-test",
    });
    const adoptionWrites = mockedWriteFileSync.mock.calls.filter(
      ([path]) => path === join(REPO_ROOT, ".polaris", "adoption-plan.json"),
    );
    expect(adoptionWrites).toHaveLength(1);
    expect(JSON.parse(adoptionWrites[0]?.[1] as string)).toMatchObject({
      approved: true,
      plan_id: "adoption-test",
    });
    expect(stdoutOutput).toContain("Adoption approval bypassed via --yes.");
    expect(stdoutOutput).toContain("Adoption changes staged.");
  });

  it("resumes an already approved adoption plan without prompting", () => {
    const config = {
      version: "1.0",
    };
    const plan = {
      plan_id: "adoption-resume",
      generated_at: "2026-05-31T00:00:00.000Z",
      repo_state: "existing",
      approved: true,
      approved_at: "2026-05-31T00:01:00.000Z",
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
    };

    mockedExistsSync.mockImplementation((path: fs.PathLike) => {
      const value = String(path);
      return value === CONFIG_PATH || value === join(REPO_ROOT, ".polaris", "adoption-plan.json");
    });
    mockedReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
      const value = String(path);
      if (value === CONFIG_PATH) {
        return JSON.stringify(config);
      }
      if (value === join(REPO_ROOT, ".polaris", "adoption-plan.json")) {
        return JSON.stringify(plan);
      }
      if (value === join(REPO_ROOT, ".polaris", "adoption-plan.md")) {
        return "# Adoption Plan\n";
      }
      return "";
    });
    const generateAdoptionArtifacts = vi.fn();
    const readAdoptionApproval = vi.fn();

    runInit({
      repoRoot: REPO_ROOT,
      adopt: true,
      resume: true,
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
      readAdoptionApproval,
      scaffoldRootSurfaces: vi.fn().mockReturnValue({ created: [], skipped: [] }),
    });

    expect(generateAdoptionArtifacts).not.toHaveBeenCalled();
    expect(readAdoptionApproval).not.toHaveBeenCalled();
    expect(stdoutOutput).toContain("# Adoption Plan");
    expect(stdoutOutput).not.toContain("Proceed with adoption?");
    expect(stdoutOutput).toContain("Adoption changes staged.");
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

describe("finalizeAdoption", () => {
  it("exits early when all adoption steps are already complete", async () => {
    await finalizeAdoption({
      plan_id: "adoption-complete",
      generated_at: "2026-06-01T00:00:00.000Z",
      repo_state: "existing",
      approved: true,
      approved_at: "2026-06-01T00:00:00.000Z",
      dry_run: false,
      steps: [
        {
          step_id: "stage-adoption",
          order: 1,
          phase: "C",
          category: "stage",
          action: "modify",
          dest_path: ".git/index",
          description: "Stage adoption outputs.",
          destructive: true,
          requires_approval: true,
          estimated_risk: "medium",
          status: "completed",
          completed_at: "2026-06-01T00:00:00.000Z",
        },
      ],
      impact_summary: {
        files_to_create: 0,
        files_to_move: 0,
        files_to_modify: 0,
        instruction_files_affected: 0,
        smartdocs_candidates_moved: 0,
        cognition_files_to_generate: 0,
      },
    });

    expect(stdoutOutput).toContain("Adoption already complete.");
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("stages adoption outputs and unstages runtime artifacts", async () => {
    mockedExistsSync.mockImplementation((path: fs.PathLike) => {
      const value = String(path);
      return value.endsWith(".gitignore") || value.endsWith(".polaris/map/index.json");
    });
    mockedReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
      const value = String(path);
      if (value.endsWith(".gitignore")) {
        return "node_modules/\n";
      }
      if (value.endsWith(".polaris/map/index.json")) {
        return JSON.stringify({ coverage_pct: 42 });
      }
      return "";
    });
    mockedExecFileSync
      .mockReturnValueOnce("")
      .mockReturnValueOnce(".taskchain_artifacts/polaris-run/current-state.json\n.polaris/adoption-plan.json\n")
      .mockReturnValueOnce("");

    await finalizeAdoption(
      {
        plan_id: "adoption-finalize",
        generated_at: "2026-06-01T00:00:00.000Z",
        repo_state: "existing",
        approved: true,
        approved_at: null,
        dry_run: false,
        steps: [
          {
            step_id: "stage-adoption",
            order: 1,
            phase: "C",
            category: "stage",
            action: "modify",
            dest_path: ".git/index",
            description: "Stage adoption outputs.",
            destructive: true,
            requires_approval: true,
            estimated_risk: "medium",
            status: "pending",
          },
        ],
        impact_summary: {
          files_to_create: 2,
          files_to_move: 3,
          files_to_modify: 4,
          instruction_files_affected: 1,
          smartdocs_candidates_moved: 3,
          cognition_files_to_generate: 6,
        },
      },
      {
        repoRoot: REPO_ROOT,
      },
    );

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      join(REPO_ROOT, ".gitignore"),
      expect.stringContaining(".polaris/runs/"),
      "utf-8",
    );
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["add", "-A", "--"]),
      expect.objectContaining({ cwd: REPO_ROOT }),
    );
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["restore", "--staged", "--", ".taskchain_artifacts/polaris-run/current-state.json"],
      expect.objectContaining({ cwd: REPO_ROOT }),
    );
    expect(stdoutOutput).toContain("Adoption changes staged.");
  });
});

describe("isBeyondSymlink", () => {
  const ROOT = "/repo";

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns false when no ancestor is a symlink", () => {
    mockedLstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
    expect(isBeyondSymlink(ROOT, "normal/path/file.md")).toBe(false);
  });

  it("returns true when a parent directory is a symlink", () => {
    mockedLstatSync.mockImplementation((p) => {
      const isSymlink = String(p) === `${ROOT}/.agents/skills`;
      return { isSymbolicLink: () => isSymlink } as fs.Stats;
    });
    expect(isBeyondSymlink(ROOT, ".agents/skills/caveman-compress/README.md")).toBe(true);
  });

  it("returns false for a top-level file (no ancestors to check)", () => {
    expect(isBeyondSymlink(ROOT, "polaris.config.json")).toBe(false);
    expect(mockedLstatSync).not.toHaveBeenCalled();
  });

  it("returns false when lstatSync throws (ancestor does not exist)", () => {
    mockedLstatSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isBeyondSymlink(ROOT, "missing/ancestor/file.md")).toBe(false);
  });
});

describe("stageAdoptionOutputs symlink filtering", () => {
  const REPO_ROOT = "/repo";

  function makeBasePlan(extraPaths: { source_path?: string; dest_path?: string }[]) {
    return {
      plan_id: "test",
      generated_at: "2026-06-09T00:00:00.000Z",
      repo_state: "existing" as const,
      approved: true,
      approved_at: null,
      dry_run: false,
      steps: extraPaths.map((p, i) => ({
        step_id: `step-${i}`,
        order: i,
        phase: "C" as const,
        category: "move" as const,
        action: "create" as const,
        description: "test step",
        destructive: false,
        requires_approval: false,
        estimated_risk: "low" as const,
        status: "complete" as const,
        ...p,
      })),
      impact_summary: {
        files_to_create: 0,
        files_to_move: 0,
        files_to_modify: 0,
        instruction_files_affected: 0,
        smartdocs_candidates_moved: 0,
        cognition_files_to_generate: 0,
      },
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    // suppress stdout/stderr
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stages only non-symlink paths when a plan step dest_path is inside a symlinked dir", async () => {
    const symlinkPath = ".agents/skills/caveman-compress/README.md";
    const normalPath = "POLARIS.md";

    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith(symlinkPath) || s.endsWith(normalPath) || s.endsWith(".gitignore") || s.endsWith(".polaris/map/index.json");
    });

    mockedReadFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith(".gitignore")) return "node_modules/\n";
      if (s.endsWith(".polaris/map/index.json")) return JSON.stringify({ coverage_pct: 50 });
      return "";
    });

    mockedLstatSync.mockImplementation((p) => {
      const isSymlink = String(p) === `${REPO_ROOT}/.agents/skills`;
      return { isSymbolicLink: () => isSymlink } as fs.Stats;
    });

    // runAdoptionAtlas call + git diff --cached + git restore
    mockedExecFileSync
      .mockReturnValueOnce("")   // git add (only valid paths)
      .mockReturnValueOnce("")   // git diff --cached
      .mockReturnValueOnce("");  // git restore

    await finalizeAdoption(makeBasePlan([{ dest_path: symlinkPath }]), { repoRoot: REPO_ROOT });

    const gitAddCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === "git" && Array.isArray(c[1]) && (c[1] as string[]).includes("add"),
    );
    expect(gitAddCall).toBeDefined();
    const addArgs = gitAddCall![1] as string[];
    expect(addArgs).not.toContain(symlinkPath);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining(`Skipping adoption output inside symlinked path: ${symlinkPath}`),
    );
  });

  it("stages valid paths when mixed with symlink-descendant paths", async () => {
    const symlinkPath = ".agents/providers/foo/config.json";
    const goodPath = "smartdocs/raw/overview.md";

    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith(symlinkPath) || s.endsWith(goodPath) || s.endsWith(".gitignore") || s.endsWith(".polaris/map/index.json");
    });

    mockedReadFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith(".gitignore")) return "node_modules/\n";
      if (s.endsWith(".polaris/map/index.json")) return JSON.stringify({ coverage_pct: 50 });
      return "";
    });

    mockedLstatSync.mockImplementation((p) => {
      const s = String(p);
      const isSymlink = s === `${REPO_ROOT}/.agents/providers`;
      return { isSymbolicLink: () => isSymlink } as fs.Stats;
    });

    mockedExecFileSync
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("");

    await finalizeAdoption(
      makeBasePlan([{ dest_path: symlinkPath }, { dest_path: goodPath }]),
      { repoRoot: REPO_ROOT },
    );

    const gitAddCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === "git" && Array.isArray(c[1]) && (c[1] as string[]).includes("add"),
    );
    expect(gitAddCall).toBeDefined();
    const addArgs = gitAddCall![1] as string[];
    expect(addArgs).toContain(goodPath);
    expect(addArgs).not.toContain(symlinkPath);
  });
});

describe("runInit --adopt — orchestration fixes", () => {
  function makeBaseAdoptOptions(overrides: Partial<Parameters<typeof runInit>[0]> = {}) {
    return {
      repoRoot: REPO_ROOT,
      adopt: true,
      yes: true,
      detectRepoState: vi.fn().mockReturnValue("existing"),
      detectProviders: vi.fn().mockReturnValue([]),
      detectRepoAnalysisProviders: vi.fn().mockReturnValue([]),
      scanAdoptionInventory: vi.fn().mockReturnValue({
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
      }),
      generateAdoptionArtifacts: vi.fn().mockReturnValue({
        plan: {
          plan_id: "test",
          generated_at: "2026-06-09T00:00:00.000Z",
          repo_state: "existing",
          approved: false,
          approved_at: null,
          dry_run: false,
          steps: [],
          impact_summary: {
            files_to_create: 0, files_to_move: 0, files_to_modify: 0,
            instruction_files_affected: 0, smartdocs_candidates_moved: 0,
            cognition_files_to_generate: 0,
          },
        },
        json: "{}\n",
        markdown: "# Adoption Plan\n",
        jsonPath: `${REPO_ROOT}/.polaris/adoption-plan.json`,
        markdownPath: `${REPO_ROOT}/.polaris/adoption-plan.md`,
        wroteFiles: false,
      }),
      applySmartDocsMigration: vi.fn().mockReturnValue({ moved: 0, skipped: 0 }),
      generateFolderCognition: vi.fn().mockResolvedValue(undefined),
      scaffoldRootSurfaces: vi.fn().mockReturnValue({ created: [], skipped: [] }),
      finalizeAdoption: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedReadFileSync.mockReturnValue("");
    mockedExecFileSync.mockReturnValue("");
  });

  it("calls scaffoldRootSurfaces with repoRoot before inventory scan", async () => {
    const callOrder: string[] = [];
    const mockScaffold = vi.fn().mockImplementation(() => {
      callOrder.push("scaffold");
      return { created: [], skipped: [] };
    });
    const mockScan = vi.fn().mockImplementation(() => {
      callOrder.push("scan");
      return {
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
    });

    await runInit(makeBaseAdoptOptions({
      scaffoldRootSurfaces: mockScaffold,
      scanAdoptionInventory: mockScan,
    }));

    expect(mockScaffold).toHaveBeenCalledWith(REPO_ROOT);
    expect(callOrder.indexOf("scaffold")).toBeLessThan(callOrder.indexOf("scan"));
  });

  it("passes repoRoot to generateFolderCognition", async () => {
    const mockCognition = vi.fn().mockResolvedValue(undefined);

    await runInit(makeBaseAdoptOptions({ generateFolderCognition: mockCognition }));

    expect(mockCognition).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      REPO_ROOT,
    );
  });

  it("awaits finalizeAdoption before returning when plan has stage step", async () => {
    let stagingComplete = false;
    const mockFinalizeAdoption = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      stagingComplete = true;
    });

    const planWithStage = {
      plan_id: "test",
      generated_at: "2026-06-09T00:00:00.000Z",
      repo_state: "existing" as const,
      approved: false,
      approved_at: null,
      dry_run: false,
      steps: [{
        step_id: "stage-adoption",
        order: 1,
        phase: "C" as const,
        category: "stage" as const,
        action: "modify" as const,
        dest_path: ".git/index",
        description: "Stage.",
        destructive: true,
        requires_approval: true,
        estimated_risk: "medium" as const,
        status: "pending" as const,
      }],
      impact_summary: {
        files_to_create: 0, files_to_move: 0, files_to_modify: 0,
        instruction_files_affected: 0, smartdocs_candidates_moved: 0,
        cognition_files_to_generate: 0,
      },
    };

    await runInit(makeBaseAdoptOptions({
      generateAdoptionArtifacts: vi.fn().mockReturnValue({
        plan: planWithStage,
        json: "{}\n",
        markdown: "# Plan\n",
        jsonPath: `${REPO_ROOT}/.polaris/adoption-plan.json`,
        markdownPath: `${REPO_ROOT}/.polaris/adoption-plan.md`,
        wroteFiles: false,
      }),
      finalizeAdoption: mockFinalizeAdoption,
    }));

    expect(stagingComplete).toBe(true);
  });

  it("does not call scaffoldRootSurfaces on dry run", async () => {
    const mockScaffold = vi.fn().mockReturnValue({ created: [], skipped: [] });

    await runInit(makeBaseAdoptOptions({ dryRun: true, scaffoldRootSurfaces: mockScaffold }));

    expect(mockScaffold).not.toHaveBeenCalled();
  });
});
