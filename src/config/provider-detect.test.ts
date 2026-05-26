import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as child_process from "node:child_process";
import { detectCaveman, detectGitNexus, detectCompactionProviders } from "./provider-detect.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedExecFileSync = vi.mocked(child_process.execFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("detectCaveman", () => {
  it("returns true when .codex/skills/caveman/SKILL.md exists", () => {
    mockedExistsSync.mockReturnValue(true);
    expect(detectCaveman("/repo")).toBe(true);
    expect(mockedExistsSync).toHaveBeenCalledWith(
      expect.stringContaining(".codex/skills/caveman/SKILL.md"),
    );
  });

  it("returns false when .codex/skills/caveman/SKILL.md is absent", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(detectCaveman("/repo")).toBe(false);
  });
});

describe("detectGitNexus", () => {
  it("returns true when `which gitnexus` succeeds", () => {
    // execFileSync does not throw → gitnexus is on PATH
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/gitnexus\n"));
    expect(detectGitNexus()).toBe(true);
  });

  it("returns false when `which gitnexus` throws", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detectGitNexus()).toBe(false);
  });
});

describe("detectCompactionProviders", () => {
  it("returns empty array when no providers are detected", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detectCompactionProviders("/repo")).toEqual([]);
  });

  it("returns ['caveman'] when only Caveman is detected", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detectCompactionProviders("/repo")).toEqual(["caveman"]);
  });

  it("returns ['gitnexus'] when only GitNexus is detected", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/bin/gitnexus\n"));
    expect(detectCompactionProviders("/repo")).toEqual(["gitnexus"]);
  });

  it("returns ['caveman', 'gitnexus'] when both are detected", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/bin/gitnexus\n"));
    expect(detectCompactionProviders("/repo")).toEqual(["caveman", "gitnexus"]);
  });
});
