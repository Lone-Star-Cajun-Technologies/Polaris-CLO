import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseReadBeforeEditingLinks,
  validateDir,
  validateInstructions,
  getLastGitModDate,
  getFilesChangedAfter,
} from "./validate-instructions.js";
import type { FileRouteEntry } from "../map/atlas.js";

const TMP = join(process.cwd(), ".test-validate-instructions-tmp");

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
  mkdirSync(join(TMP, ".polaris/map"), { recursive: true });
  writeFileSync(join(TMP, "polaris.config.json"), JSON.stringify({ repo: {}, map: {} }));
  writeFileSync(join(TMP, ".polaris/map/file-routes.json"), JSON.stringify({}));
  writeFileSync(join(TMP, ".polaris/map/needs-review.json"), JSON.stringify({}));
}

function teardown(): void {
  rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// parseReadBeforeEditingLinks
// ---------------------------------------------------------------------------

describe("parseReadBeforeEditingLinks", () => {
  it("returns empty array when no section present", () => {
    const content = "# Title\n\n## Purpose\nsome text";
    expect(parseReadBeforeEditingLinks(content)).toEqual([]);
  });

  it("extracts local markdown links from section", () => {
    const content = [
      "# Title",
      "",
      "## Read before editing",
      "",
      "- [Design spec](../docs/spec.md)",
      "- [Atlas](../map/atlas.ts)",
      "",
      "## Other section",
    ].join("\n");
    const links = parseReadBeforeEditingLinks(content);
    expect(links).toContain("../docs/spec.md");
    expect(links).toContain("../map/atlas.ts");
  });

  it("ignores external URLs", () => {
    const content = [
      "## Read before editing",
      "",
      "- [External](https://example.com/doc)",
      "- [Local](./local.md)",
    ].join("\n");
    const links = parseReadBeforeEditingLinks(content);
    expect(links).not.toContain("https://example.com/doc");
    expect(links).toContain("./local.md");
  });

  it("does not bleed into next section", () => {
    const content = [
      "## Read before editing",
      "",
      "- [Good](./good.md)",
      "",
      "## Related routes",
      "",
      "- [Other](./other.md)",
    ].join("\n");
    const links = parseReadBeforeEditingLinks(content);
    expect(links).toContain("./good.md");
    expect(links).not.toContain("./other.md");
  });
});

// ---------------------------------------------------------------------------
// validateDir — MISSING
// ---------------------------------------------------------------------------

describe("validateDir - MISSING", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns MISSING when no POLARIS.md exists", () => {
    const result = validateDir("src/map", TMP, {});
    expect(result.status).toBe("MISSING");
    expect(result.polarisFile).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateDir — OK
// ---------------------------------------------------------------------------

function validPolarisContent(extra?: string): string {
  return [
    "# map",
    "",
    "## Purpose",
    "Some text.",
    "",
    "## What belongs here",
    "- files",
    "",
    "## What does not belong here",
    "none",
    "",
    "## Editing rules",
    "none",
    "",
    "## Architecture assumptions",
    "none",
    "",
    "## Read before editing",
    extra ?? "none",
    "",
    "## Related routes",
    "none",
  ].join("\n");
}

describe("validateDir - OK", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns OK for a POLARIS.md with no issues (no git history, no links, no atlas)", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), validPolarisContent());
    const result = validateDir("src/map", TMP, {});
    expect(result.status).toBe("OK");
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateDir — SUMMARY.md (WARN/ERROR)
// ---------------------------------------------------------------------------

describe("validateDir - SUMMARY.md", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("reports WARN when SUMMARY.md is missing", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), validPolarisContent());
    // Add 5 files to atlas to trigger Signal 5
    const routes: Record<string, FileRouteEntry> = {
      "src/map/f1.ts": makeEntry(),
      "src/map/f2.ts": makeEntry(),
      "src/map/f3.ts": makeEntry(),
      "src/map/f4.ts": makeEntry(),
      "src/map/f5.ts": makeEntry(),
    };
    const result = validateDir("src/map", TMP, routes);
    expect(result.status).toBe("WARN");
    const warnFinding = result.findings.find((f) => f.severity === "WARN");
    expect(warnFinding?.message).toContain("Missing SUMMARY.md");
  });

  it("reports OK when SUMMARY.md exists and is clean", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), validPolarisContent());
    writeFileSync(join(TMP, "src/map/SUMMARY.md"), "# Summary\nNo modal verbs here.");
    const result = validateDir("src/map", TMP, {});
    expect(result.status).toBe("OK");
  });

  it("reports ERROR when SUMMARY.md has doctrine bleed (must/never/always)", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), validPolarisContent());
    writeFileSync(join(TMP, "src/map/SUMMARY.md"), "# Summary\nAgents must always be polite.");
    const result = validateDir("src/map", TMP, {});
    expect(result.status).toBe("ERROR");
    const errorFindings = result.findings.filter((f) => f.severity === "ERROR");
    expect(errorFindings).toHaveLength(2); // must and always
    expect(errorFindings[0]?.message).toContain("doctrine bleed risk");
  });
});

// ---------------------------------------------------------------------------
// validateDir — broken links (ERROR)
// ---------------------------------------------------------------------------

describe("validateDir - broken links", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("reports ERROR for a broken link in Read before editing", () => {
    const content = validPolarisContent("- [Missing spec](../nonexistent/spec.md)");
    writeFileSync(join(TMP, "src/map/POLARIS.md"), content);
    const result = validateDir("src/map", TMP, {});
    expect(result.status).toBe("ERROR");
    const errorFinding = result.findings.find((f) => f.severity === "ERROR");
    expect(errorFinding?.message).toContain("Broken link");
    expect(errorFinding?.message).toContain("../nonexistent/spec.md");
  });

  it("does not report error for an existing linked file", () => {
    writeFileSync(join(TMP, "src/map/atlas.ts"), "// file");
    const content = validPolarisContent("- [Atlas](./atlas.ts)");
    writeFileSync(join(TMP, "src/map/POLARIS.md"), content);
    const result = validateDir("src/map", TMP, {});
    expect(result.status).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// validateDir — instructionFile pointer (ERROR)
// ---------------------------------------------------------------------------

describe("validateDir - instructionFile pointer", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("reports ERROR when atlas instructionFile pointer references a non-existent file", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), validPolarisContent());
    const routes: Record<string, FileRouteEntry> = {
      "src/map/atlas.ts": makeEntry({ instructionFile: "src/map/POLARIS.md" }),
      "src/map/update.ts": makeEntry({ instructionFile: "src/map/GHOST.md" }),
    };
    const result = validateDir("src/map", TMP, routes);
    expect(result.status).toBe("ERROR");
    const errorFinding = result.findings.find((f) => f.severity === "ERROR");
    expect(errorFinding?.message).toContain("src/map/GHOST.md");
  });

  it("does not report error when instructionFile exists", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), validPolarisContent());
    const routes: Record<string, FileRouteEntry> = {
      "src/map/atlas.ts": makeEntry({ instructionFile: "src/map/POLARIS.md" }),
    };
    const result = validateDir("src/map", TMP, routes);
    expect(result.status).toBe("OK");
  });

  it("ignores atlas entries for other directories", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), validPolarisContent());
    const routes: Record<string, FileRouteEntry> = {
      "src/cli/index.ts": makeEntry({ instructionFile: "src/cli/GHOST.md" }),
    };
    const result = validateDir("src/map", TMP, routes);
    expect(result.status).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// validateInstructions — overall
// ---------------------------------------------------------------------------

describe("validateInstructions", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns hasErrors=false when all checks pass", () => {
    writeFileSync(join(TMP, "src/map/POLARIS.md"), validPolarisContent());
    const report = validateInstructions({ repoRoot: TMP, path: "src/map" });
    expect(report.hasErrors).toBe(false);
  });

  it("returns hasErrors=true when there is an ERROR", () => {
    const content = validPolarisContent("- [Missing](./nonexistent.md)");
    writeFileSync(join(TMP, "src/map/POLARIS.md"), content);
    const report = validateInstructions({ repoRoot: TMP, path: "src/map" });
    expect(report.hasErrors).toBe(true);
  });

  it("reports MISSING for a dir without POLARIS.md", () => {
    const report = validateInstructions({ repoRoot: TMP, path: "src/map" });
    expect(report.results[0]?.status).toBe("MISSING");
  });

  it("--fix writes POLARIS.draft.md for MISSING dir", () => {
    const report = validateInstructions({ repoRoot: TMP, path: "src/map", fix: true });
    const result = report.results[0];
    expect(result?.status).toBe("MISSING");
    expect(existsSync(join(TMP, "src/map/POLARIS.draft.md"))).toBe(true);
    const draftFinding = result?.findings.find((f) =>
      f.message === "Draft written to POLARIS.draft.md",
    );
    expect(draftFinding).toBeDefined();
  });

  it("--fix does not overwrite existing POLARIS.md", () => {
    const original = "# Original\n";
    writeFileSync(join(TMP, "src/map/POLARIS.md"), original);
    validateInstructions({ repoRoot: TMP, path: "src/map", fix: true });
    // POLARIS.md should be untouched — only POLARIS.draft.md is written
    expect(readFileSync(join(TMP, "src/map/POLARIS.md"), "utf-8")).toBe(original);
  });

  it("scopes validation to --path", () => {
    // Only src/map checked; other dirs are irrelevant
    const report = validateInstructions({ repoRoot: TMP, path: "src/map" });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.dir).toBe("src/map");
  });
});

// ---------------------------------------------------------------------------
// getLastGitModDate / getFilesChangedAfter — graceful fallback
// ---------------------------------------------------------------------------

describe("getLastGitModDate", () => {
  it("returns null for a non-existent path in a real repo (graceful)", () => {
    const result = getLastGitModDate("/tmp/nonexistent-file.md", "/tmp");
    expect(result).toBeNull();
  });
});

describe("getFilesChangedAfter", () => {
  it("returns empty array when no files changed (graceful)", () => {
    const futureDate = new Date(Date.now() + 1_000_000_000);
    const result = getFilesChangedAfter("/tmp", futureDate, "/tmp");
    expect(result).toEqual([]);
  });
});
