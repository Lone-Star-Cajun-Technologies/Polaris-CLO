/**
 * Tests for map validation including role_owner field (POL-231).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMapValidate } from "./validate.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-validate-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRoutes(dir: string, routes: Record<string, unknown>): void {
  const mapDir = join(dir, ".polaris", "map");
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(mapDir, "file-routes.json"), JSON.stringify(routes), "utf-8");
  writeFileSync(join(mapDir, "needs-review.json"), JSON.stringify({}), "utf-8");
  writeFileSync(join(mapDir, "exemptions.json"), JSON.stringify({}), "utf-8");
}

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    domain: "cli",
    route: "src/cli",
    taskchain: "polaris-cli",
    confidence: 0.9,
    classification: "indexed",
    last_updated: new Date().toISOString(),
    updated_by: "test",
    tags: ["cli"],
    ...overrides,
  };
}

describe("runMapValidate role_owner validation", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("passes validation when role_owner is a valid value", () => {
    const entryPath = join(testDir, "src/cli/index.ts");
    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(entryPath, "");

    writeRoutes(testDir, {
      "src/cli/index.ts": makeEntry({ role_owner: "worker" }),
    });

    const result = runMapValidate(testDir, 9999);
    expect(result.invalidRoleOwner).toHaveLength(0);
    expect(result.hasError).toBe(false);
  });

  it("fails validation when role_owner is an unknown value", () => {
    const entryPath = join(testDir, "src/cli/index.ts");
    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(entryPath, "");

    writeRoutes(testDir, {
      "src/cli/index.ts": makeEntry({ role_owner: "unknown-role" }),
    });

    const result = runMapValidate(testDir, 9999);
    expect(result.invalidRoleOwner).toContain("src/cli/index.ts");
    expect(result.hasError).toBe(true);
  });

  it("passes validation when role_owner is absent (optional field)", () => {
    const entryPath = join(testDir, "src/cli/index.ts");
    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(entryPath, "");

    writeRoutes(testDir, {
      "src/cli/index.ts": makeEntry(), // no role_owner
    });

    const result = runMapValidate(testDir, 9999);
    expect(result.invalidRoleOwner).toHaveLength(0);
  });

  it("accepts all valid role_owner values", () => {
    const validRoles = ["worker", "foreman", "analyst", "librarian", "any"];
    for (const role of validRoles) {
      const entryPath = join(testDir, "src/cli/index.ts");
      mkdirSync(join(testDir, "src/cli"), { recursive: true });
      writeFileSync(entryPath, "");

      writeRoutes(testDir, {
        "src/cli/index.ts": makeEntry({ role_owner: role }),
      });

      const result = runMapValidate(testDir, 9999);
      expect(result.invalidRoleOwner).toHaveLength(0);
      expect(result.hasError).toBe(false);
    }
  });
});

describe("runMapValidate identity completeness", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("passes when route has both instructionFile and role_owner", () => {
    const entryPath = join(testDir, "src/cli/index.ts");
    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(entryPath, "");

    writeRoutes(testDir, {
      "src/cli/index.ts": makeEntry({ instructionFile: "POLARIS.md", role_owner: "worker" }),
    });

    const result = runMapValidate(testDir, 9999);
    expect(result.identityIncomplete).toHaveLength(0);
  });

  it("lists route missing instructionFile", () => {
    const entryPath = join(testDir, "src/cli/index.ts");
    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(entryPath, "");

    writeRoutes(testDir, {
      "src/cli/index.ts": makeEntry({ role_owner: "worker" }), // missing instructionFile
    });

    const result = runMapValidate(testDir, 9999);
    expect(result.identityIncomplete).toContain("src/cli/index.ts");
    expect(result.identityIncomplete).toHaveLength(1);
  });

  it("lists route missing role_owner", () => {
    const entryPath = join(testDir, "src/cli/index.ts");
    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(entryPath, "");

    writeRoutes(testDir, {
      "src/cli/index.ts": makeEntry({ instructionFile: "POLARIS.md" }), // missing role_owner
    });

    const result = runMapValidate(testDir, 9999);
    expect(result.identityIncomplete).toContain("src/cli/index.ts");
    expect(result.identityIncomplete).toHaveLength(1);
  });

  it("lists route missing both instructionFile and role_owner", () => {
    const entryPath = join(testDir, "src/cli/index.ts");
    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(entryPath, "");

    writeRoutes(testDir, {
      "src/cli/index.ts": makeEntry(), // missing both fields
    });

    const result = runMapValidate(testDir, 9999);
    expect(result.identityIncomplete).toContain("src/cli/index.ts");
    expect(result.identityIncomplete).toHaveLength(1);
  });

  it("lists multiple routes with identity incompleteness", () => {
    const entryPath1 = join(testDir, "src/cli/index.ts");
    const entryPath2 = join(testDir, "src/map/atlas.ts");
    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    mkdirSync(join(testDir, "src/map"), { recursive: true });
    writeFileSync(entryPath1, "");
    writeFileSync(entryPath2, "");

    writeRoutes(testDir, {
      "src/cli/index.ts": makeEntry({ role_owner: "worker" }), // missing instructionFile
      "src/map/atlas.ts": makeEntry(), // missing both
    });

    const result = runMapValidate(testDir, 9999);
    expect(result.identityIncomplete).toHaveLength(2);
    expect(result.identityIncomplete).toContain("src/cli/index.ts");
    expect(result.identityIncomplete).toContain("src/map/atlas.ts");
  });
});
