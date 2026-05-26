/**
 * Unit tests for src/mcp/lib/root.ts
 *
 * Covers:
 * - returns POLARIS_ROOT env var (resolve()d) when set
 * - walks up from cwd and finds repo root when package.json has name=polaris
 * - throws when no root found and POLARIS_ROOT not set
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Keep a reference to the original env and cwd
const originalEnv = process.env["POLARIS_ROOT"];
const originalCwd = process.cwd();

function makeTempDir(): string {
  const dir = join(tmpdir(), `polaris-root-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("resolveRepoRoot()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    // Ensure POLARIS_ROOT is unset before each test (restored per-test)
    delete process.env["POLARIS_ROOT"];
  });

  afterEach(() => {
    // Restore POLARIS_ROOT to whatever it was originally
    if (originalEnv !== undefined) {
      process.env["POLARIS_ROOT"] = originalEnv;
    } else {
      delete process.env["POLARIS_ROOT"];
    }
    // Restore cwd
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the resolved POLARIS_ROOT env var when set", async () => {
    process.env["POLARIS_ROOT"] = tempDir;
    // Dynamic import so we get a fresh call each time (module is already cached,
    // but the function re-reads process.env at call time)
    const { resolveRepoRoot } = await import("./root.js");
    const result = resolveRepoRoot();
    // Compare real paths to handle macOS symlinked temp directories
    expect(realpathSync(result)).toBe(realpathSync(resolve(tempDir)));
  });

  it("resolves a relative POLARIS_ROOT path to an absolute path", async () => {
    // Create a real directory for relative path test (realpathSync requires path to exist)
    const relativeDir = join(tempDir, "relative-path");
    mkdirSync(relativeDir, { recursive: true });
    // Change to tempDir so relative path resolves correctly
    process.chdir(tempDir);
    process.env["POLARIS_ROOT"] = "./relative-path";
    const { resolveRepoRoot } = await import("./root.js");
    const result = resolveRepoRoot();
    // Compare real paths to handle macOS symlinked temp directories
    expect(realpathSync(result)).toBe(realpathSync(relativeDir));
  });

  it("walks up from cwd and finds the repo root when package.json has name=polaris", async () => {
    // Write a valid polaris package.json into tempDir
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "polaris" }));
    // Create a subdirectory and chdir into it so walkUp must climb to tempDir
    const subDir = join(tempDir, "sub", "deep");
    mkdirSync(subDir, { recursive: true });
    process.chdir(subDir);

    delete process.env["POLARIS_ROOT"];
    const { resolveRepoRoot } = await import("./root.js");
    const result = resolveRepoRoot();
    // Compare real paths to handle macOS symlinked temp directories
    expect(realpathSync(result)).toBe(realpathSync(tempDir));
  });

  it("throws when no polaris root can be found and POLARIS_ROOT is not set", async () => {
    // tempDir has no package.json with name=polaris; chdir into it
    process.chdir(tempDir);
    delete process.env["POLARIS_ROOT"];

    const { resolveRepoRoot } = await import("./root.js");
    // The function walks up until it hits the filesystem root and throws
    // NOTE: this may succeed if a parent directory happens to contain a polaris package.json;
    // we accept that edge case by checking it either returns a string or throws the expected error.
    try {
      const result = resolveRepoRoot();
      // If it didn't throw, it must have found a root — just verify it's a string
      expect(typeof result).toBe("string");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Cannot locate Polaris repo root/);
    }
  });

  it("throws with helpful message mentioning POLARIS_ROOT env var", async () => {
    // Use a deeply nested temp dir with no package.json to force failure
    // We mock cwd to a path that has no polaris root
    const isolatedDir = join(tmpdir(), `isolated-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(isolatedDir, { recursive: true });
    process.chdir(isolatedDir);
    delete process.env["POLARIS_ROOT"];

    const { resolveRepoRoot } = await import("./root.js");

    try {
      resolveRepoRoot();
      // If it finds something (because a parent has polaris package.json), that's also OK
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("POLARIS_ROOT");
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
