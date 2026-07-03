import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCanonCheck, runSmartDocsLinkCheck } from "./canon-check.js";
import { checkSmartDocsLinks } from "./doctrine.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `canon-check-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTelemetryFile(dir: string): string {
  const telDir = join(dir, "telemetry");
  mkdirSync(telDir, { recursive: true });
  return join(telDir, "telemetry.jsonl");
}

describe("runCanonCheck", () => {
  let testDir: string;
  let telemetryFile: string;

  beforeEach(() => {
    testDir = makeTestDir();
    telemetryFile = makeTelemetryFile(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("aligned outcome", () => {
    it("returns aligned when no changed files are provided", () => {
      const result = runCanonCheck({
        repoRoot: testDir,
        changedFiles: [],
        runId: "test-run-1",
        telemetryFile,
      });
      expect(result.outcome).toBe("aligned");
      expect(result.conflicts).toEqual([]);
    });

    it("returns aligned when no POLARIS.md or canon dirs exist", () => {
      const result = runCanonCheck({
        repoRoot: testDir,
        changedFiles: ["src/loop/continue.ts"],
        runId: "test-run-1",
        telemetryFile,
      });
      expect(result.outcome).toBe("aligned");
      expect(result.conflicts).toEqual([]);
    });

    it("returns aligned when POLARIS.md has no rules mentioning changed files as deleted", () => {
      mkdirSync(join(testDir, "src", "loop"), { recursive: true });
      writeFileSync(join(testDir, "src", "loop", "continue.ts"), "// placeholder");
      writeFileSync(
        join(testDir, "POLARIS.md"),
        [
          "# POLARIS.md",
          "",
          "## Editing rules",
          "- State writes must use checkpoint.ts",
          "- Keep loop files small",
          "",
          "## Architecture assumptions",
          "- Bootstrap packets are immutable once written",
        ].join("\n"),
      );

      const result = runCanonCheck({
        repoRoot: testDir,
        changedFiles: ["src/loop/continue.ts"],
        runId: "test-run-1",
        telemetryFile,
      });
      expect(result.outcome).toBe("aligned");
      expect(result.conflicts).toEqual([]);
    });

    it("sets canonFilesInspected based on found canon files", () => {
      writeFileSync(
        join(testDir, "POLARIS.md"),
        "# POLARIS.md\n## Editing rules\n- No special rules\n",
      );
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "src", "foo.ts"), "// code");

      const result = runCanonCheck({
        repoRoot: testDir,
        changedFiles: ["src/foo.ts"],
        runId: "test-run-1",
        telemetryFile,
      });
      expect(result.canonFilesInspected).toBeGreaterThan(0);
    });
  });

  describe("SUMMARY.md exclusion", () => {
    it("excludes SUMMARY.md from triggering canon lookup", () => {
      // Create a POLARIS.md that would normally be found
      writeFileSync(join(testDir, "POLARIS.md"), "# POLARIS.md\n");

      const result = runCanonCheck({
        repoRoot: testDir,
        changedFiles: ["SUMMARY.md"],
        runId: "test-summary-exclude",
        telemetryFile,
      });

      // Should not find any canon files because SUMMARY.md was ignored
      expect(result.canonFilesInspected).toBe(0);
      expect(result.outcome).toBe("aligned");
    });

    it("does not report conflicts for SUMMARY.md even if it contains 'must' and 'deleted'", () => {
      // Create a SUMMARY.md with modal verbs that would normally trigger checkDocFile
      writeFileSync(join(testDir, "SUMMARY.md"), "Agents must not use old-file.ts as it is deleted.");
      mkdirSync(join(testDir, "docs", "doctrine", "active"), { recursive: true });

      const result = runCanonCheck({
        repoRoot: testDir,
        changedFiles: ["src/some-file.ts"],
        runId: "test-summary-no-conflict",
        telemetryFile,
      });

      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe("stale-implementation outcome", () => {
    it("returns stale-implementation when POLARIS.md says a file is deleted but it still exists", () => {
      mkdirSync(join(testDir, "src", "loop"), { recursive: true });
      writeFileSync(join(testDir, "src", "loop", "old-module.ts"), "// still here");
      writeFileSync(
        join(testDir, "POLARIS.md"),
        [
          "# POLARIS.md",
          "",
          "## Architecture assumptions",
          "- old-module.ts has been deleted and must not be used",
        ].join("\n"),
      );

      const result = runCanonCheck({
        repoRoot: testDir,
        changedFiles: ["src/loop/old-module.ts"],
        runId: "test-run-1",
        telemetryFile,
      });
      expect(result.outcome).toBe("stale-implementation");
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts[0].type).toBe("stale-implementation");
    });

    it("emits canon-conflict-halt telemetry event on stale-implementation", () => {
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "src", "legacy.ts"), "// still exists");
      writeFileSync(
        join(testDir, "POLARIS.md"),
        [
          "# POLARIS.md",
          "",
          "## Architecture assumptions",
          "- legacy.ts has been removed and should not be referenced",
        ].join("\n"),
      );

      runCanonCheck({
        repoRoot: testDir,
        changedFiles: ["src/legacy.ts"],
        runId: "test-run-halt",
        telemetryFile,
        childId: "POL-99",
      });

      const lines = readFileSync(telemetryFile, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const halt = lines.find((e) => e.event === "canon-conflict-halt");
      expect(halt).toBeTruthy();
      expect(halt.run_id).toBe("test-run-halt");
      expect(halt.child_id).toBe("POL-99");
    });
  });

  describe("telemetry events", () => {
    it("emits canon-check-start event", () => {
      runCanonCheck({
        repoRoot: testDir,
        changedFiles: ["src/foo.ts"],
        runId: "test-run-tel",
        telemetryFile,
        childId: "POL-51",
      });

      const lines = readFileSync(telemetryFile, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const start = lines.find((e) => e.event === "canon-check-start");
      expect(start).toBeTruthy();
      expect(start.run_id).toBe("test-run-tel");
      expect(start.child_id).toBe("POL-51");
      expect(typeof start.changed_files_count).toBe("number");
    });

    it("emits canon-check-result event for aligned outcome", () => {
      runCanonCheck({
        repoRoot: testDir,
        changedFiles: [],
        runId: "test-run-aligned",
        telemetryFile,
      });

      const lines = readFileSync(telemetryFile, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const result = lines.find((e) => e.event === "canon-check-result");
      expect(result).toBeTruthy();
      expect(result.outcome).toBe("aligned");
      expect(result.conflicts).toEqual([]);
    });

    it("sets child_id to null when not provided", () => {
      runCanonCheck({
        repoRoot: testDir,
        changedFiles: [],
        runId: "test-run-no-child",
        telemetryFile,
      });

      const lines = readFileSync(telemetryFile, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const start = lines.find((e) => e.event === "canon-check-start");
      expect(start.child_id).toBeNull();
    });
  });

  describe("config flags", () => {
    it("does not alter return value — callers control skip logic", () => {
      // canon-check itself has no checkOnContinue/checkOnFinalize logic;
      // skipping is the caller's responsibility. Just verify function is callable.
      const checkResult = runCanonCheck({
        repoRoot: testDir,
        changedFiles: [],
        runId: "test-flag",
        telemetryFile,
      });
      expect(checkResult).toBeDefined();
    });
  });

  describe("POLARIS.md nearest ancestor lookup", () => {
    it("finds POLARIS.md in a parent directory", () => {
      mkdirSync(join(testDir, "src", "loop", "deep"), { recursive: true });
      writeFileSync(join(testDir, "src", "loop", "deep", "file.ts"), "// code");
      writeFileSync(
        join(testDir, "src", "POLARIS.md"),
        "# POLARIS.md\n## Editing rules\n- no rules\n",
      );

      const result = runCanonCheck({
        repoRoot: testDir,
        changedFiles: ["src/loop/deep/file.ts"],
        runId: "test-ancestor",
        telemetryFile,
      });
      expect(result.canonFilesInspected).toBeGreaterThan(0);
    });
  });
});

describe("checkSmartDocsLinks", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `smartdocs-link-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns no conflicts for a valid relative link in active/", () => {
    const activeDir = join(testDir, "smartdocs", "doctrine", "active");
    mkdirSync(activeDir, { recursive: true });
    const targetFile = join(activeDir, "concept.md");
    writeFileSync(targetFile, "# Concept");
    const sourceFile = join(activeDir, "source.md");
    const content = "See [concept](./concept.md) for details.";
    writeFileSync(sourceFile, content);

    const conflicts = checkSmartDocsLinks(sourceFile, content, testDir);
    expect(conflicts).toHaveLength(0);
  });

  it("returns stale-assumption conflict for broken relative link in active/", () => {
    const activeDir = join(testDir, "smartdocs", "doctrine", "active");
    mkdirSync(activeDir, { recursive: true });
    const sourceFile = join(activeDir, "source.md");
    const content = "See [missing](./missing-concept.md) for details.";
    writeFileSync(sourceFile, content);

    const conflicts = checkSmartDocsLinks(sourceFile, content, testDir);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe("stale-assumption");
    expect(conflicts[0].detail).toContain("missing-concept.md");
  });

  it("returns no conflicts for a broken link in raw/ (permissive tier)", () => {
    const rawDir = join(testDir, "smartdocs", "raw");
    mkdirSync(rawDir, { recursive: true });
    const sourceFile = join(rawDir, "draft.md");
    const content = "See [gone](./gone-doc.md) for details.";
    writeFileSync(sourceFile, content);

    // raw/ is permissive — broken links are never flagged
    const conflicts = checkSmartDocsLinks(sourceFile, content, testDir);
    expect(conflicts).toHaveLength(0);
  });

  it("resolves bundle-relative link (/smartdocs/...) correctly and flags missing target", () => {
    const activeDir = join(testDir, "smartdocs", "doctrine", "active");
    mkdirSync(activeDir, { recursive: true });
    const sourceFile = join(activeDir, "source.md");
    // Bundle-relative link to a non-existent target
    const content = "See [spec](/smartdocs/specs/active/nonexistent.md).";
    writeFileSync(sourceFile, content);

    const conflicts = checkSmartDocsLinks(sourceFile, content, testDir);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe("stale-assumption");
    expect(conflicts[0].detail).toContain("nonexistent.md");
  });

  it("resolves bundle-relative link (/smartdocs/...) and does NOT flag when target exists", () => {
    const activeDir = join(testDir, "smartdocs", "doctrine", "active");
    const specsDir = join(testDir, "smartdocs", "specs", "active");
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, "myspec.md"), "# Spec");
    const sourceFile = join(activeDir, "source.md");
    const content = "See [spec](/smartdocs/specs/active/myspec.md).";
    writeFileSync(sourceFile, content);

    const conflicts = checkSmartDocsLinks(sourceFile, content, testDir);
    expect(conflicts).toHaveLength(0);
  });

  it("returns stale-assumption conflict for broken link in candidate/", () => {
    const candidateDir = join(testDir, "smartdocs", "doctrine", "candidate");
    mkdirSync(candidateDir, { recursive: true });
    const sourceFile = join(candidateDir, "proposal.md");
    const content = "Depends on [old-api](./old-api.md).";
    writeFileSync(sourceFile, content);

    const conflicts = checkSmartDocsLinks(sourceFile, content, testDir);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe("stale-assumption");
  });

  it("ignores external URLs and non-smartdocs links", () => {
    const activeDir = join(testDir, "smartdocs", "doctrine", "active");
    mkdirSync(activeDir, { recursive: true });
    const sourceFile = join(activeDir, "source.md");
    const content = [
      "See [external](https://example.com/doc.md).",
      "Also [src-link](/src/some-module.ts).",
    ].join("\n");
    writeFileSync(sourceFile, content);

    const conflicts = checkSmartDocsLinks(sourceFile, content, testDir);
    expect(conflicts).toHaveLength(0);
  });
});

describe("runSmartDocsLinkCheck", () => {
  let testDir: string;
  let telemetryFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `smartdocs-link-walk-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const telDir = join(testDir, "telemetry");
    mkdirSync(telDir, { recursive: true });
    telemetryFile = join(telDir, "telemetry.jsonl");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns zero conflicts and zero filesChecked when no strict dirs exist", () => {
    const result = runSmartDocsLinkCheck({
      repoRoot: testDir,
      runId: "test-run-link",
      telemetryFile,
    });
    expect(result.filesChecked).toBe(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it("walks active/ and flags broken links as stale-assumption", () => {
    const activeDir = join(testDir, "smartdocs", "doctrine", "active");
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(activeDir, "doc.md"), "See [missing](./gone.md).");

    const result = runSmartDocsLinkCheck({
      repoRoot: testDir,
      runId: "test-run-broken",
      telemetryFile,
    });
    expect(result.filesChecked).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].type).toBe("stale-assumption");
  });

  it("does not check files in raw/ (permissive)", () => {
    const rawDir = join(testDir, "smartdocs", "raw");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "draft.md"), "See [broken](./nonexistent.md).");

    const result = runSmartDocsLinkCheck({
      repoRoot: testDir,
      runId: "test-run-raw",
      telemetryFile,
    });
    // raw/ is not a strict dir — never walked
    expect(result.filesChecked).toBe(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it("emits smartdocs-link-check-result telemetry event", () => {
    const result = runSmartDocsLinkCheck({
      repoRoot: testDir,
      runId: "test-run-tel",
      telemetryFile,
      childId: "POL-447",
    });

    const lines = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const evt = lines.find((e) => e.event === "smartdocs-link-check-result");
    expect(evt).toBeTruthy();
    expect(evt.run_id).toBe("test-run-tel");
    expect(evt.child_id).toBe("POL-447");
    expect(typeof evt.files_checked).toBe("number");
    expect(typeof evt.broken_links).toBe("number");
    void result;
  });
});
