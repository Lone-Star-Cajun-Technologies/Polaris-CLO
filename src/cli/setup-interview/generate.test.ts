import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { generateSetupArtifacts } from "./generate.js";
import { createInterviewRecord } from "./schema.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

const REPO_ROOT = "/fake-repo";

function makeRecord(answers: Record<string, unknown> = {}) {
  return {
    ...createInterviewRecord(new Date("2026-06-26T00:00:00.000Z")),
    status: "answered" as const,
    answers: {
      project_purpose: "test project",
      source_roots: ["src"],
      languages: ["typescript"],
      canonical_doc_folders: ["docs"],
      never_touch: [],
      providers_by_role: {},
      ...answers,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(fs.readdirSync).mockReturnValue([]);
});

describe("generateSetupArtifacts", () => {
  it("dry-run prints the plan and writes nothing", async () => {
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    await generateSetupArtifacts(makeRecord(), {
      repoRoot: REPO_ROOT,
      dryRun: true,
      stdout,
    });

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    const written = stdout.write as ReturnType<typeof vi.fn>;
    expect(written).toHaveBeenCalledWith(expect.stringContaining("# Setup Plan"));
    expect(written).toHaveBeenCalledWith("Setup dry run: no files written.\n");
  });

  it("--yes bypasses the approval prompt and writes artifacts", async () => {
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const scaffold = vi.fn().mockReturnValue({ created: [], skipped: [] });
    const rules = vi.fn().mockResolvedValue(undefined);
    const migrate = vi.fn().mockResolvedValue(undefined);
    const mapIndex = vi.fn();

    await generateSetupArtifacts(makeRecord(), {
      repoRoot: REPO_ROOT,
      yes: true,
      stdout,
      scaffoldRootSurfaces: scaffold,
      generatePolarisRules: rules,
      migrateSmartDocs: migrate,
      runMapIndex: mapIndex,
    });

    const written = stdout.write as ReturnType<typeof vi.fn>;
    expect(written).toHaveBeenCalledWith("Setup approval bypassed via --yes.\n");
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${REPO_ROOT}/GENESIS.md`,
      expect.stringContaining("# Genesis"),
      "utf-8",
    );
    const configWrite = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([path]) => path === `${REPO_ROOT}/polaris.config.json`,
    );
    expect(configWrite).toBeDefined();
    const writtenConfig = JSON.parse(configWrite![1] as string) as Record<string, unknown>;
    expect(writtenConfig).toMatchObject({
      repo: { sourceRoots: ["src"], docsRoots: ["docs"] },
    });
    expect(scaffold).toHaveBeenCalledWith(REPO_ROOT);
    expect(rules).toHaveBeenCalledWith(REPO_ROOT, expect.any(Object), expect.any(Object));
    expect(migrate).toHaveBeenCalledWith(expect.any(Object), REPO_ROOT);
    expect(mapIndex).toHaveBeenCalledWith(REPO_ROOT, false, false, { seedCognition: false, skipThreshold: true });
  });

  it("prompts for approval and aborts when denied", async () => {
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const stdin = { on: vi.fn(), pause: vi.fn(), resume: vi.fn(), isTTY: false } as unknown as NodeJS.ReadStream;
    const promptApproval = vi.fn().mockResolvedValue(false);
    const scaffold = vi.fn().mockReturnValue({ created: [], skipped: [] });

    await generateSetupArtifacts(makeRecord(), {
      repoRoot: REPO_ROOT,
      stdout,
      stdin,
      promptApproval,
      scaffoldRootSurfaces: scaffold,
    });

    expect(promptApproval).toHaveBeenCalledOnce();
    expect(scaffold).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    const written = stdout.write as ReturnType<typeof vi.fn>;
    expect(written).toHaveBeenCalledWith("Setup aborted: explicit approval required.\n");
  });

  it("prompts for approval and writes artifacts when approved", async () => {
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const promptApproval = vi.fn().mockResolvedValue(true);
    const scaffold = vi.fn().mockReturnValue({ created: [], skipped: [] });
    const rules = vi.fn().mockResolvedValue(undefined);
    const migrate = vi.fn().mockResolvedValue(undefined);
    const mapIndex = vi.fn();

    await generateSetupArtifacts(makeRecord(), {
      repoRoot: REPO_ROOT,
      stdout,
      promptApproval,
      scaffoldRootSurfaces: scaffold,
      generatePolarisRules: rules,
      migrateSmartDocs: migrate,
      runMapIndex: mapIndex,
    });

    expect(promptApproval).toHaveBeenCalledOnce();
    const configWrite = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([path]) => path === `${REPO_ROOT}/polaris.config.json`,
    );
    expect(configWrite).toBeDefined();
    expect(scaffold).toHaveBeenCalledWith(REPO_ROOT);
    expect(mapIndex).toHaveBeenCalled();
  });

  it("writes providers_by_role into execution.providers", async () => {
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const scaffold = vi.fn().mockReturnValue({ created: [], skipped: [] });
    const rules = vi.fn().mockResolvedValue(undefined);
    const migrate = vi.fn().mockResolvedValue(undefined);
    const mapIndex = vi.fn();

    await generateSetupArtifacts(
      makeRecord({ providers_by_role: { foreman: "devin", worker: "codex" } }),
      {
        repoRoot: REPO_ROOT,
        yes: true,
        stdout,
        scaffoldRootSurfaces: scaffold,
        generatePolarisRules: rules,
        migrateSmartDocs: migrate,
        runMapIndex: mapIndex,
      },
    );

    const configWrite = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([path]) => path === `${REPO_ROOT}/polaris.config.json`,
    );
    expect(configWrite).toBeDefined();
    const written = JSON.parse(configWrite![1] as string) as Record<string, unknown>;
    expect(written).toMatchObject({
      execution: {
        providers: {
          foreman: { command: "devin" },
          worker: { command: "codex" },
        },
      },
    });
  });

  it("preserves detected providers in config", async () => {
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const scaffold = vi.fn().mockReturnValue({ created: [], skipped: [] });
    const rules = vi.fn().mockResolvedValue(undefined);
    const migrate = vi.fn().mockResolvedValue(undefined);
    const mapIndex = vi.fn();

    await generateSetupArtifacts(makeRecord(), {
      repoRoot: REPO_ROOT,
      yes: true,
      stdout,
      detectedProviders: ["caveman"],
      detectedRepoAnalysis: ["gitnexus"],
      scaffoldRootSurfaces: scaffold,
      generatePolarisRules: rules,
      migrateSmartDocs: migrate,
      runMapIndex: mapIndex,
    });

    const configWrite = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([path]) => path === `${REPO_ROOT}/polaris.config.json`,
    );
    expect(configWrite).toBeDefined();
    const written = JSON.parse(configWrite![1] as string) as Record<string, unknown>;
    expect(written).toMatchObject({
      providers: {
        compactionProviders: ["caveman"],
        repoAnalysis: { preferred: "gitnexus" },
      },
    });
  });
});
