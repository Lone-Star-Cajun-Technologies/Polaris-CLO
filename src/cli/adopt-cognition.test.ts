import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { generateFolderCognition } from "./adopt-cognition.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
  };
});

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedStatSync = vi.mocked(fs.statSync);
const mockedReaddirSync = vi.mocked(fs.readdirSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

const REPO_ROOT = "/injected-cognition-repo";

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
  source_roots: ["src"],
  docs_roots: [],
  test_commands: [],
  build_commands: [],
  package_scripts: {},
  generated_roots: [],
  cache_roots: [],
  fixture_roots: [],
  existing_smartdocs_dirs: [],
  architecture_notes: [],
  likely_canonical_folders: ["src"],
  smartdocs_candidates: [],
  ignore_candidates: [],
  agent_instruction_files: [],
};

beforeEach(() => { vi.resetAllMocks(); });

describe("generateFolderCognition — repoRoot injection", () => {
  it("writes POLARIS.md under the injected repoRoot, not process.cwd()", async () => {
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      // folder exists, but no POLARIS.md yet
      return s === `${REPO_ROOT}/src`;
    });
    mockedStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    // return 3+ source files so eligibility check passes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedReaddirSync as any).mockReturnValue([
      { name: "a.ts", isDirectory: () => false, isFile: () => true },
      { name: "b.ts", isDirectory: () => false, isFile: () => true },
      { name: "c.ts", isDirectory: () => false, isFile: () => true },
    ]);

    await generateFolderCognition(BASE_PLAN, BASE_INVENTORY, REPO_ROOT);

    const polarisWrite = mockedWriteFileSync.mock.calls.find(
      ([p]) => String(p).endsWith("POLARIS.md"),
    );
    expect(polarisWrite).toBeDefined();
    expect(String(polarisWrite![0])).toContain(REPO_ROOT);
    expect(String(polarisWrite![0])).not.toContain(process.cwd());
  });

  it("returns immediately on dry_run without writes", async () => {
    await generateFolderCognition({ ...BASE_PLAN, dry_run: true }, BASE_INVENTORY, REPO_ROOT);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it("skips folder if POLARIS.md already exists", async () => {
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      // both folder and POLARIS.md exist
      return s === `${REPO_ROOT}/src` || s === `${REPO_ROOT}/src/POLARIS.md`;
    });
    mockedStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedReaddirSync as any).mockReturnValue([
      { name: "a.ts", isDirectory: () => false, isFile: () => true },
      { name: "b.ts", isDirectory: () => false, isFile: () => true },
      { name: "c.ts", isDirectory: () => false, isFile: () => true },
    ]);

    await generateFolderCognition(BASE_PLAN, BASE_INVENTORY, REPO_ROOT);

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});
