import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveInstructionFile, computeInstructionCoverage } from "./atlas.js";

const TMP = join(process.cwd(), ".test-update-tmp");

function setup(): void {
  mkdirSync(join(TMP, "src/map"), { recursive: true });
  mkdirSync(join(TMP, "src/cli"), { recursive: true });
  mkdirSync(join(TMP, "src/deep/nested/dir"), { recursive: true });
  writeFileSync(join(TMP, "src/map/POLARIS.md"), "# Map instructions");
  writeFileSync(join(TMP, "POLARIS.md"), "# Root instructions");
}

function teardown(): void {
  rmSync(TMP, { recursive: true, force: true });
}

describe("resolveInstructionFile", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("finds POLARIS.md in the same directory as the file", () => {
    const result = resolveInstructionFile("src/map/atlas.ts", TMP);
    expect(result).toBe("src/map/POLARIS.md");
  });

  it("finds root POLARIS.md for a file in a directory without one", () => {
    const result = resolveInstructionFile("src/cli/index.ts", TMP);
    expect(result).toBe("POLARIS.md");
  });

  it("finds nearest ancestor POLARIS.md for deeply nested file", () => {
    const result = resolveInstructionFile("src/deep/nested/dir/file.ts", TMP);
    expect(result).toBe("POLARIS.md");
  });

  it("returns undefined when no POLARIS.md exists anywhere", () => {
    rmSync(join(TMP, "POLARIS.md"));
    const result = resolveInstructionFile("src/cli/index.ts", TMP);
    expect(result).toBeUndefined();
  });

  it("prefers the closest ancestor over a more distant one", () => {
    writeFileSync(join(TMP, "src/deep/POLARIS.md"), "# Deep src instructions");
    const result = resolveInstructionFile("src/deep/nested/dir/file.ts", TMP);
    expect(result).toBe("src/deep/POLARIS.md");
  });
});

describe("computeInstructionCoverage", () => {
  it("returns zero coverage for empty entries", () => {
    const result = computeInstructionCoverage({});
    expect(result).toEqual({ routesCovered: 0, routesTotal: 0, coveragePercent: 0 });
  });

  it("counts covered and total correctly", () => {
    const entries = {
      "src/a.ts": { domain: "x", route: "x", taskchain: "x", confidence: 1, classification: "indexed" as const, last_updated: "", updated_by: "", tags: [], instructionFile: "POLARIS.md" },
      "src/b.ts": { domain: "x", route: "x", taskchain: "x", confidence: 1, classification: "indexed" as const, last_updated: "", updated_by: "", tags: [] },
    };
    const result = computeInstructionCoverage(entries);
    expect(result.routesCovered).toBe(1);
    expect(result.routesTotal).toBe(2);
    expect(result.coveragePercent).toBe(50);
  });

  it("returns 100% when all entries have instructionFile", () => {
    const entries = {
      "src/a.ts": { domain: "x", route: "x", taskchain: "x", confidence: 1, classification: "indexed" as const, last_updated: "", updated_by: "", tags: [], instructionFile: "POLARIS.md" },
      "src/b.ts": { domain: "x", route: "x", taskchain: "x", confidence: 1, classification: "indexed" as const, last_updated: "", updated_by: "", tags: [], instructionFile: "src/POLARIS.md" },
    };
    const result = computeInstructionCoverage(entries);
    expect(result.coveragePercent).toBe(100);
  });
});
