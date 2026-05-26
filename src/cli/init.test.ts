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
  };
});

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

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

    runInit({ repoRoot: REPO_ROOT, detectProviders: detect });

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

    runInit({ repoRoot: REPO_ROOT, detectProviders: detect });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    expect(written).not.toHaveProperty("providers.compactionProviders");
  });

  it("includes both caveman and gitnexus when both detected", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue(["caveman", "gitnexus"]);

    runInit({ repoRoot: REPO_ROOT, detectProviders: detect });

    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    expect((written.providers as Record<string, unknown>).compactionProviders).toEqual([
      "caveman",
      "gitnexus",
    ]);
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

    runInit({ repoRoot: REPO_ROOT, detectProviders: detect });

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

    runInit({ repoRoot: REPO_ROOT, detectProviders: detect });

    const [, content] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const written = JSON.parse(content) as Record<string, unknown>;
    const providers = written.providers as Record<string, unknown>;
    expect(providers.repoAnalysis).toEqual({ preferred: "polaris-map" });
    expect(providers.compactionProviders).toEqual(["caveman"]);
  });

  it("removes compactionProviders from existing config when none detected", () => {
    const existingConfig = {
      version: "1.0",
      providers: { compactionProviders: ["caveman"] },
    };
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));
    const detect = vi.fn().mockReturnValue([]);

    runInit({ repoRoot: REPO_ROOT, detectProviders: detect });

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

    runInit({ repoRoot: REPO_ROOT, dryRun: true, detectProviders: detect });

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("prints the JSON to stdout in dry-run mode", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue(["caveman"]);

    runInit({ repoRoot: REPO_ROOT, dryRun: true, detectProviders: detect });

    const parsed = JSON.parse(stdoutOutput) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      providers: { compactionProviders: ["caveman"] },
    });
  });
});

describe("runInit — stdout messaging", () => {
  it("prints detected providers in success message", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue(["caveman", "gitnexus"]);

    runInit({ repoRoot: REPO_ROOT, detectProviders: detect });

    expect(stdoutOutput).toContain("caveman");
    expect(stdoutOutput).toContain("gitnexus");
  });

  it("reports no providers when none detected", () => {
    mockedExistsSync.mockReturnValue(false);
    const detect = vi.fn().mockReturnValue([]);

    runInit({ repoRoot: REPO_ROOT, detectProviders: detect });

    expect(stdoutOutput).toContain("No compaction providers detected");
  });
});
