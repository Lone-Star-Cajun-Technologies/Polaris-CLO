import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldRootSurfaces } from "./adopt-workspace.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    lstatSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedLstatSync = vi.mocked(fs.lstatSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
const mockedMkdirSync = vi.mocked(fs.mkdirSync);

const REPO_ROOT = "/test-repo";

beforeEach(() => { vi.resetAllMocks(); });

describe("scaffoldRootSurfaces", () => {
  it("creates all five surfaces when none exist", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedLstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);

    const result = scaffoldRootSurfaces(REPO_ROOT);

    expect(result.created).toEqual(
      expect.arrayContaining([
        "POLARIS.md",
        "SUMMARY.md",
        "CLAUDE.md",
        "AGENTS.md",
        ".github/copilot-instructions.md",
      ]),
    );
    expect(result.skipped).toHaveLength(0);
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(5);
    expect(mockedMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".github"),
      { recursive: true },
    );
  });

  it("skips surfaces that already exist", () => {
    mockedExistsSync.mockImplementation((p) =>
      String(p).endsWith("POLARIS.md") || String(p).endsWith("CLAUDE.md"),
    );
    mockedLstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);

    const result = scaffoldRootSurfaces(REPO_ROOT);

    expect(result.created).toEqual(
      expect.arrayContaining(["SUMMARY.md", "AGENTS.md", ".github/copilot-instructions.md"]),
    );
    expect(result.skipped).toEqual(
      expect.arrayContaining(["POLARIS.md", "CLAUDE.md"]),
    );
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(3);
  });

  it("skips a surface when its parent directory is a symlink", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedLstatSync.mockImplementation((p) => {
      const isSymlink = String(p) === `${REPO_ROOT}/.github`;
      return { isSymbolicLink: () => isSymlink } as fs.Stats;
    });

    const result = scaffoldRootSurfaces(REPO_ROOT);

    expect(result.created).not.toContain(".github/copilot-instructions.md");
    expect(result.skipped).toContain(".github/copilot-instructions.md");
  });

  it("never writes outside repoRoot", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedLstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);

    scaffoldRootSurfaces(REPO_ROOT);

    for (const [path] of mockedWriteFileSync.mock.calls) {
      expect(String(path).startsWith(REPO_ROOT)).toBe(true);
    }
  });

  it("written POLARIS.md contains polaris:draft marker", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedLstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);

    scaffoldRootSurfaces(REPO_ROOT);

    const polarisWrite = mockedWriteFileSync.mock.calls.find(([p]) =>
      String(p).endsWith("POLARIS.md"),
    );
    expect(String(polarisWrite![1])).toContain("<!-- polaris:draft -->");
  });

  it("written CLAUDE.md and AGENTS.md contain Polaris delegation pointer", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedLstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);

    scaffoldRootSurfaces(REPO_ROOT);

    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const call = mockedWriteFileSync.mock.calls.find(([p]) => String(p).endsWith(name));
      expect(String(call![1])).toContain("POLARIS.md");
    }
  });

  it("POLARIS.md draft includes ## Polaris Rules section referencing POLARIS_RULES.md", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedLstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);

    scaffoldRootSurfaces(REPO_ROOT);

    const polarisWrite = mockedWriteFileSync.mock.calls.find(([p]) =>
      String(p).endsWith("POLARIS.md"),
    );
    const content = String(polarisWrite![1]);
    expect(content).toContain("## Polaris Rules");
    expect(content).toContain("POLARIS_RULES.md");
  });
});
