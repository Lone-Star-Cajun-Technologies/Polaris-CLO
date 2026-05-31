import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DRAFT_MARKER,
  hasDraftMarker,
  generateDraft,
  seedInstructions,
  seedInstructionsAll,
  generateSummaryDraft,
  seedSummary,
  seedSummaryAll,
} from "./seed-instructions.js";
import type { FileRouteEntry } from "../map/atlas.js";

const TMP = join(process.cwd(), ".test-docs-seed-tmp");

function makeEntry(overrides: Partial<FileRouteEntry> = {}): FileRouteEntry {
  return {
    domain: "test-domain",
    route: "test-route",
    taskchain: "test-chain",
    confidence: 0.9,
    classification: "indexed",
    last_updated: "2026-01-01T00:00:00Z",
    updated_by: "test",
    tags: [],
    ...overrides,
  };
}

function setup(): void {
  mkdirSync(join(TMP, "src/map"), { recursive: true });
  mkdirSync(join(TMP, "src/cli"), { recursive: true });
  mkdirSync(join(TMP, ".polaris/map"), { recursive: true });
  // Minimal polaris.config.json so loadConfig doesn't fail
  writeFileSync(join(TMP, "polaris.config.json"), JSON.stringify({ repo: {}, map: {} }));
  // Empty atlas files
  writeFileSync(join(TMP, ".polaris/map/file-routes.json"), JSON.stringify({}));
  writeFileSync(join(TMP, ".polaris/map/needs-review.json"), JSON.stringify({}));
}

function teardown(): void {
  rmSync(TMP, { recursive: true, force: true });
}

describe("hasDraftMarker", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns true when file starts with draft marker", () => {
    writeFileSync(join(TMP, "POLARIS.md"), `${DRAFT_MARKER}\n# title`);
    expect(hasDraftMarker(join(TMP, "POLARIS.md"))).toBe(true);
  });

  it("returns false when file has no draft marker", () => {
    writeFileSync(join(TMP, "POLARIS.md"), "# Human-written doc");
    expect(hasDraftMarker(join(TMP, "POLARIS.md"))).toBe(false);
  });

  it("returns false for nonexistent file", () => {
    expect(hasDraftMarker(join(TMP, "nonexistent.md"))).toBe(false);
  });
});

describe("generateDraft", () => {
  it("includes draft marker at top", () => {
    const content = generateDraft("src/map", TMP, {});
    expect(content.startsWith(DRAFT_MARKER)).toBe(true);
  });

  it("uses directory basename as heading", () => {
    const content = generateDraft("src/map", TMP, {});
    expect(content).toContain("# map");
  });

  it("includes domain and route from atlas entries in that directory", () => {
    const routes: Record<string, FileRouteEntry> = {
      "src/map/atlas.ts": makeEntry({ domain: "atlas", route: "polaris-map" }),
    };
    const content = generateDraft("src/map", TMP, routes);
    expect(content).toContain("atlas");
    expect(content).toContain("polaris-map");
  });

  it("lists files in the directory", () => {
    const routes: Record<string, FileRouteEntry> = {
      "src/map/atlas.ts": makeEntry({ domain: "atlas", route: "polaris-map" }),
      "src/map/update.ts": makeEntry({ domain: "atlas", route: "polaris-map" }),
    };
    const content = generateDraft("src/map", TMP, routes);
    expect(content).toContain("`atlas.ts`");
    expect(content).toContain("`update.ts`");
  });

  it("does not include files from other directories", () => {
    const routes: Record<string, FileRouteEntry> = {
      "src/cli/index.ts": makeEntry({ domain: "cli", route: "polaris-cli" }),
      "src/map/atlas.ts": makeEntry({ domain: "atlas", route: "polaris-map" }),
    };
    const content = generateDraft("src/map", TMP, routes);
    expect(content).not.toContain("`index.ts`");
  });
});

describe("seedInstructions", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("writes a POLARIS.md draft and returns written", () => {
    const result = seedInstructions("src/map", TMP);
    expect(result).toBe("written");
    const outPath = join(TMP, "src/map/POLARIS.md");
    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, "utf-8");
    expect(content).toContain(DRAFT_MARKER);
  });

  it("returns skipped-exists when human-edited POLARIS.md present", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), "# Human-edited");
    const result = seedInstructions("src/map", TMP);
    expect(result).toBe("skipped-exists");
  });

  it("returns skipped-draft when draft POLARIS.md already present", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), `${DRAFT_MARKER}\n# Draft`);
    const result = seedInstructions("src/map", TMP);
    expect(result).toBe("skipped-draft");
  });

  it("does not write file in dry-run mode", () => {
    const result = seedInstructions("src/map", TMP, { dryRun: true });
    expect(result).toBe("written");
    expect(existsSync(join(TMP, "src/map/POLARIS.md"))).toBe(false);
  });
});

describe("seedInstructionsAll", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("generates drafts for directories without POLARIS.md", () => {
    const { written, skippedIneligible } = seedInstructionsAll(TMP);
    expect(written).toContain("src/map");
    expect(written).toContain("src/cli");
    expect(skippedIneligible).toBeDefined();
  });

  it("skips directories with human-edited POLARIS.md", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), "# Human-edited");
    const { written, skippedExists, skippedIneligible } = seedInstructionsAll(TMP);
    expect(skippedExists).toContain("src/map");
    expect(written).not.toContain("src/map");
    expect(skippedIneligible).toBeDefined();
  });

  it("skips directories with draft POLARIS.md", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), `${DRAFT_MARKER}\n# Draft`);
    const { skippedDraft, skippedIneligible } = seedInstructionsAll(TMP);
    expect(skippedDraft).toContain("src/map");
    expect(skippedIneligible).toBeDefined();
  });

  it("does not write files in dry-run mode", () => {
    const { written, skippedIneligible } = seedInstructionsAll(TMP, { dryRun: true });
    expect(written.length).toBeGreaterThan(0);
    for (const dir of written) {
      expect(existsSync(join(TMP, dir, "POLARIS.md"))).toBe(false);
    }
    expect(skippedIneligible).toBeDefined();
  });

  it("skips ineligible directories like node_modules and dist", () => {
    // Create ineligible directories
    mkdirSync(join(TMP, "node_modules"), { recursive: true });
    mkdirSync(join(TMP, "dist"), { recursive: true });
    mkdirSync(join(TMP, "src/node_modules"), { recursive: true });

    const { written, skippedIneligible } = seedInstructionsAll(TMP);

    // node_modules and dist should be in skippedIneligible
    const ineligiblePaths = skippedIneligible.map((s) => s.path);
    expect(ineligiblePaths).toContain("node_modules");
    expect(ineligiblePaths).toContain("dist");
    expect(ineligiblePaths).toContain("src/node_modules");

    // node_modules and dist should NOT be in written
    expect(written).not.toContain("node_modules");
    expect(written).not.toContain("dist");
    expect(written).not.toContain("src/node_modules");
  });

  it("skips root by default for POLARIS.md", () => {
    const { written, skippedRoot } = seedInstructionsAll(TMP);
    // Root should not be in written
    expect(written).not.toContain(".");
    // Root should be in skippedRoot
    expect(skippedRoot).toBeDefined();
    expect(skippedRoot?.path).toBe(".");
  });

  it("includes top-level Polaris runtime cognition folders but skips generated descendants", () => {
    mkdirSync(join(TMP, ".polaris/bootstrap"), { recursive: true });
    mkdirSync(join(TMP, ".polaris/clusters/POL-123"), { recursive: true });
    mkdirSync(join(TMP, ".polaris/runs/run-123"), { recursive: true });

    const { written, skippedIneligible } = seedInstructionsAll(TMP);
    const ineligiblePaths = skippedIneligible.map((s) => s.path);

    expect(written).toContain(".polaris");
    expect(written).toContain(".polaris/bootstrap");
    expect(written).toContain(".polaris/clusters");
    expect(written).toContain(".polaris/map");
    expect(written).toContain(".polaris/runs");
    expect(ineligiblePaths).toContain(".polaris/clusters/POL-123");
    expect(ineligiblePaths).toContain(".polaris/runs/run-123");
  });

  it("includes root when includeRoot option is set", () => {
    const { written, skippedRoot } = seedInstructionsAll(TMP, { includeRoot: true });
    // Root should be in written
    expect(written).toContain(".");
    // Root should not be in skippedRoot
    expect(skippedRoot).toBeUndefined();
  });
});

describe("generateSummaryDraft", () => {
  it("includes draft marker at top", () => {
    const content = generateSummaryDraft("src/map", TMP, {});
    expect(content.startsWith(DRAFT_MARKER)).toBe(true);
  });

  it("uses directory basename in heading", () => {
    const content = generateSummaryDraft("src/map", TMP, {});
    expect(content).toContain("# Summary: map");
  });

  it("includes all standard schema sections", () => {
    const content = generateSummaryDraft("src/map", TMP, {});
    expect(content).toContain("## Purpose");
    expect(content).toContain("## Core Concepts");
    expect(content).toContain("## Architectural Role");
    expect(content).toContain("## Key Constraints");
    expect(content).toContain("## Important Relationships");
    expect(content).toContain("## Current State");
    expect(content).toContain("## Known Drift");
    expect(content).toContain("## Linked Canonical Sources");
  });
});

describe("seedSummary", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("writes a SUMMARY.md draft and returns written", () => {
    const result = seedSummary("src/map", TMP);
    expect(result).toBe("written");
    const outPath = join(TMP, "src/map/SUMMARY.md");
    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, "utf-8");
    expect(content).toContain(DRAFT_MARKER);
    expect(content).toContain("# Summary: map");
  });

  it("returns skipped-exists when human-edited SUMMARY.md present", () => {
    writeFileSync(join(TMP, "src/map/SUMMARY.md"), "# Human-edited");
    const result = seedSummary("src/map", TMP);
    expect(result).toBe("skipped-exists");
  });

  it("returns skipped-draft when draft SUMMARY.md already present", () => {
    writeFileSync(join(TMP, "src/map/SUMMARY.md"), `${DRAFT_MARKER}\n# Draft`);
    const result = seedSummary("src/map", TMP);
    expect(result).toBe("skipped-draft");
  });

  it("does not write file in dry-run mode", () => {
    const result = seedSummary("src/map", TMP, { dryRun: true });
    expect(result).toBe("written");
    expect(existsSync(join(TMP, "src/map/SUMMARY.md"))).toBe(false);
  });
});

describe("seedSummaryAll", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("generates drafts for directories without SUMMARY.md", () => {
    const { written, skippedIneligible } = seedSummaryAll(TMP);
    expect(written).toContain("src/map");
    expect(written).toContain("src/cli");
    expect(skippedIneligible).toBeDefined();
  });

  it("skips root by default for SUMMARY.md", () => {
    const { written, skippedRoot } = seedSummaryAll(TMP);
    // Root should not be in written
    expect(written).not.toContain(".");
    // Root should be in skippedRoot
    expect(skippedRoot).toBeDefined();
    expect(skippedRoot?.path).toBe(".");
  });

  it("includes top-level Polaris runtime summaries but skips generated descendants", () => {
    mkdirSync(join(TMP, ".polaris/bootstrap"), { recursive: true });
    mkdirSync(join(TMP, ".polaris/clusters/POL-123"), { recursive: true });
    mkdirSync(join(TMP, ".polaris/runs/run-123"), { recursive: true });

    const { written, skippedIneligible } = seedSummaryAll(TMP);
    const ineligiblePaths = skippedIneligible.map((s) => s.path);

    expect(written).toContain(".polaris");
    expect(written).toContain(".polaris/bootstrap");
    expect(written).toContain(".polaris/clusters");
    expect(written).toContain(".polaris/map");
    expect(written).toContain(".polaris/runs");
    expect(ineligiblePaths).toContain(".polaris/clusters/POL-123");
    expect(ineligiblePaths).toContain(".polaris/runs/run-123");
  });

  it("includes root when includeRoot option is set for SUMMARY.md", () => {
    const { written, skippedRoot } = seedSummaryAll(TMP, { includeRoot: true });
    // Root should be in written
    expect(written).toContain(".");
    // Root should not be in skippedRoot
    expect(skippedRoot).toBeUndefined();
  });

  it("skips directories with human-edited SUMMARY.md", () => {
    writeFileSync(join(TMP, "src/map/SUMMARY.md"), "# Human-edited");
    const { written, skippedExists, skippedIneligible } = seedSummaryAll(TMP);
    expect(skippedExists).toContain("src/map");
    expect(written).not.toContain("src/map");
    expect(skippedIneligible).toBeDefined();
  });

  it("skips directories with draft SUMMARY.md", () => {
    writeFileSync(join(TMP, "src/map/SUMMARY.md"), `${DRAFT_MARKER}\n# Draft`);
    const { skippedDraft, skippedIneligible } = seedSummaryAll(TMP);
    expect(skippedDraft).toContain("src/map");
    expect(skippedIneligible).toBeDefined();
  });

  it("skips ineligible directories like node_modules and dist", () => {
    // Create ineligible directories
    mkdirSync(join(TMP, "node_modules"), { recursive: true });
    mkdirSync(join(TMP, "dist"), { recursive: true });
    mkdirSync(join(TMP, "coverage"), { recursive: true });

    const { written, skippedIneligible } = seedSummaryAll(TMP);

    // node_modules, dist, coverage should be in skippedIneligible
    const ineligiblePaths = skippedIneligible.map((s) => s.path);
    expect(ineligiblePaths).toContain("node_modules");
    expect(ineligiblePaths).toContain("dist");
    expect(ineligiblePaths).toContain("coverage");

    // node_modules, dist, coverage should NOT be in written
    expect(written).not.toContain("node_modules");
    expect(written).not.toContain("dist");
    expect(written).not.toContain("coverage");
  });
});
