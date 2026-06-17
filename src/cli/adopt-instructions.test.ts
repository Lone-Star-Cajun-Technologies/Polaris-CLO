import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { handleInstructionFiles } from "./adopt-instructions.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

const REPO_ROOT = "/injected-repo";

const BASE_PLAN = {
  plan_id: "test",
  generated_at: "2026-06-09T00:00:00.000Z",
  repo_state: "existing" as const,
  approved: true,
  approved_at: null,
  dry_run: false,
  steps: [],
  impact_summary: {
    files_to_create: 0, files_to_move: 0, files_to_modify: 0,
    instruction_files_affected: 0, smartdocs_candidates_moved: 0,
    cognition_files_to_generate: 0,
  },
};

const BASE_INVENTORY = {
  scan_date: "2026-06-09T00:00:00.000Z",
  repo_state: "existing" as const,
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

beforeEach(() => { vi.resetAllMocks(); });

describe("handleInstructionFiles — repoRoot injection", () => {
  it("uses the injected repoRoot, not process.cwd()", async () => {
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s === `${REPO_ROOT}/CLAUDE.md` || s === `${REPO_ROOT}/POLARIS.md`;
    });
    mockedReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("CLAUDE.md")) return "# Old instructions";
      return "";
    });

    await handleInstructionFiles(
      { ...BASE_PLAN },
      { ...BASE_INVENTORY, agent_instruction_files: [{ path: "CLAUDE.md", provider: "claude", recommendation: "preserve", reason: "test", size_bytes: 100, has_polaris_delegation: false }] },
      REPO_ROOT,
    );

    // provenance write should target REPO_ROOT, not process.cwd()
    const provenanceCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([p]) => String(p).includes("adoption-provenance"),
    );
    expect(provenanceCall).toBeDefined();
    expect(String(provenanceCall![0])).toContain(REPO_ROOT);
    expect(String(provenanceCall![0])).not.toContain(process.cwd());
    // existsSync should have been called with the injected repoRoot path
    expect(mockedExistsSync).toHaveBeenCalledWith(`${REPO_ROOT}/CLAUDE.md`);
  });

  it("skips inventory entries with unsupported paths", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("# Some content");

    await handleInstructionFiles(
      { ...BASE_PLAN },
      {
        ...BASE_INVENTORY,
        agent_instruction_files: [
          { path: "README.md", provider: "claude" as const, recommendation: "preserve" as const, reason: "test", size_bytes: 50, has_polaris_delegation: false },
        ],
      },
      REPO_ROOT,
    );

    // README.md is not a supported instruction path — no writes should happen
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
  });

  it("returns immediately on dry_run without any writes", async () => {
    await handleInstructionFiles(
      { ...BASE_PLAN, dry_run: true },
      { ...BASE_INVENTORY, agent_instruction_files: [{ path: "CLAUDE.md", provider: "claude", recommendation: "preserve", reason: "test", size_bytes: 100, has_polaris_delegation: false }] },
      REPO_ROOT,
    );

    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it("thin adapter content points to POLARIS_RULES.md", async () => {
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s === `${REPO_ROOT}/CLAUDE.md` || s === `${REPO_ROOT}/POLARIS_RULES.md`;
    });
    mockedReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("CLAUDE.md")) return "# Old instructions with real content";
      return "";
    });

    await handleInstructionFiles(
      { ...BASE_PLAN },
      { ...BASE_INVENTORY, agent_instruction_files: [{ path: "CLAUDE.md", provider: "claude", recommendation: "preserve", reason: "test", size_bytes: 100, has_polaris_delegation: false }] },
      REPO_ROOT,
    );

    // The thin adapter written to CLAUDE.md should reference POLARIS_RULES.md
    // Use exact path to avoid matching the backup file which also ends with CLAUDE.md
    const claudeWrite = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([p]) => String(p) === `${REPO_ROOT}/CLAUDE.md`,
    );
    expect(claudeWrite).toBeDefined();
    expect(String(claudeWrite![1])).toContain("POLARIS_RULES.md");
  });

  it("preserves file already containing POLARIS_RULES.md pointer", async () => {
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s === `${REPO_ROOT}/CLAUDE.md` || s === `${REPO_ROOT}/POLARIS_RULES.md`;
    });
    mockedReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("CLAUDE.md"))
        return "# Agent Instructions\n\nRead [POLARIS_RULES.md](POLARIS_RULES.md) before doing any work.";
      return "";
    });

    await handleInstructionFiles(
      { ...BASE_PLAN },
      { ...BASE_INVENTORY, agent_instruction_files: [{ path: "CLAUDE.md", provider: "claude", recommendation: "preserve", reason: "test", size_bytes: 100, has_polaris_delegation: false }] },
      REPO_ROOT,
    );

    // File already has POLARIS_RULES.md delegation — should not be overwritten
    const claudeWrite = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([p]) => String(p).endsWith("CLAUDE.md"),
    );
    expect(claudeWrite).toBeUndefined();
  });

  it("provenance records source path, backup path, decision, timestamp, and migration outcome", async () => {
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s === `${REPO_ROOT}/CLAUDE.md` || s === `${REPO_ROOT}/POLARIS_RULES.md`;
    });
    mockedReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("CLAUDE.md")) return "# Old instructions with real content";
      return "";
    });

    await handleInstructionFiles(
      { ...BASE_PLAN },
      { ...BASE_INVENTORY, agent_instruction_files: [{ path: "CLAUDE.md", provider: "claude", recommendation: "preserve", reason: "test", size_bytes: 100, has_polaris_delegation: false }] },
      REPO_ROOT,
    );

    // Provenance should be written with the required fields
    const provenanceCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      ([p]) => String(p).includes("adoption-provenance"),
    );
    expect(provenanceCall).toBeDefined();
    const written = JSON.parse(String(provenanceCall![1])) as {
      instruction_file_actions: Array<{
        source_path: string;
        backup_path: string | null;
        decision: string;
        timestamp: string;
      }>;
    };
    expect(written.instruction_file_actions).toHaveLength(1);
    const record = written.instruction_file_actions[0];
    expect(record.source_path).toBe("CLAUDE.md");
    expect(record.decision).toBe("thin-adapter");
    expect(record.backup_path).toContain("migrated-instructions");
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
