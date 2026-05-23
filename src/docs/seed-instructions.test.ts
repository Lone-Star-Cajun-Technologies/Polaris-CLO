import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DRAFT_MARKER, hasDraftMarker, generateDraft, seedInstructions, seedInstructionsAll } from "./seed-instructions.js";
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
    const { written } = seedInstructionsAll(TMP);
    expect(written).toContain("src/map");
    expect(written).toContain("src/cli");
  });

  it("skips directories with human-edited POLARIS.md", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), "# Human-edited");
    const { written, skippedExists } = seedInstructionsAll(TMP);
    expect(skippedExists).toContain("src/map");
    expect(written).not.toContain("src/map");
  });

  it("skips directories with draft POLARIS.md", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), `${DRAFT_MARKER}\n# Draft`);
    const { skippedDraft } = seedInstructionsAll(TMP);
    expect(skippedDraft).toContain("src/map");
  });

  it("does not write files in dry-run mode", () => {
    const { written } = seedInstructionsAll(TMP, { dryRun: true });
    expect(written.length).toBeGreaterThan(0);
    for (const dir of written) {
      expect(existsSync(join(TMP, dir, "POLARIS.md"))).toBe(false);
    }
  });
});
