import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runMapBackfill } from "./backfill.js";

const TMP = join(process.cwd(), ".test-backfill-tmp");

const EXISTING_ROUTES = {
  "src/cli/index.ts": {
    domain: "cli",
    route: "src/cli",
    taskchain: "polaris-cli",
    confidence: 0.95,
    classification: "indexed" as const,
    last_updated: "2026-05-22T20:00:00Z",
    updated_by: "polaris-map-index",
    tags: ["cli", "entry-point"],
  },
};

const POLARIS_CONFIG = {
  repo: { sourceRoots: ["src"], docsRoots: [], sidecarOutputPath: ".polaris/map" },
  map: { autoWriteAbove: 0.85, confidenceThreshold: 0.75 },
};

function setup(): void {
  mkdirSync(join(TMP, ".polaris/map"), { recursive: true });
  mkdirSync(join(TMP, "src/cli"), { recursive: true });
  mkdirSync(join(TMP, "src/map"), { recursive: true });
  // Pre-existing file already in atlas
  writeFileSync(join(TMP, "src/cli/index.ts"), "");
  // New unmapped file — should be backfilled
  writeFileSync(join(TMP, "src/cli/version.ts"), "");
  // New file in a different domain
  writeFileSync(join(TMP, "src/map/backfill.ts"), "");
  writeFileSync(join(TMP, ".polaris/map/file-routes.json"), JSON.stringify(EXISTING_ROUTES));
  writeFileSync(join(TMP, ".polaris/map/needs-review.json"), JSON.stringify({}));
  writeFileSync(join(TMP, ".polaris/map/exemptions.json"), JSON.stringify({}));
  writeFileSync(join(TMP, ".polaris/map/index.json"), JSON.stringify({ scan_date: "", file_count: 0, coverage_pct: 0, entries: {} }));
  writeFileSync(join(TMP, "polaris.config.json"), JSON.stringify(POLARIS_CONFIG));
  writeFileSync(join(TMP, ".polarisignore"), "*.log\n");
}

function teardown(): void {
  rmSync(TMP, { recursive: true, force: true });
}

function captureOutput(fn: () => void): { stdout: string; stderr: string } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  console.log = (...args: unknown[]) => { stdoutLines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(" ")); };
  process.stdout.write = (chunk: unknown) => { stdoutLines.push(String(chunk)); return true; };
  process.stderr.write = (chunk: unknown) => { stderrLines.push(String(chunk)); return true; };

  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }

  return { stdout: stdoutLines.join(""), stderr: stderrLines.join("") };
}

describe("runMapBackfill", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("adds unmapped files to file-routes.json without touching existing entries", () => {
    captureOutput(() => runMapBackfill(TMP, false, undefined, false));
    const routes = JSON.parse(readFileSync(join(TMP, ".polaris/map/file-routes.json"), "utf-8"));
    // Existing entry preserved
    expect(routes["src/cli/index.ts"].confidence).toBe(0.95);
    expect(routes["src/cli/index.ts"].updated_by).toBe("polaris-map-index");
    // New entry added
    expect(routes["src/cli/version.ts"] || routes["src/map/backfill.ts"]).toBeTruthy();
  });

  it("reports correct summary counts", () => {
    const { stdout } = captureOutput(() => runMapBackfill(TMP, false, undefined, false));
    expect(stdout).toMatch(/Backfilled \d+ files\. Added \d+\. Queued \d+ for review\. Skipped \d+/);
    // src/cli/index.ts should be counted as skipped
    expect(stdout).toContain("Skipped 1");
  });

  it("does not write files when --dry-run is set", () => {
    const beforeRoutes = readFileSync(join(TMP, ".polaris/map/file-routes.json"), "utf-8");
    const { stdout } = captureOutput(() => runMapBackfill(TMP, true, undefined, false));
    const afterRoutes = readFileSync(join(TMP, ".polaris/map/file-routes.json"), "utf-8");
    expect(afterRoutes).toBe(beforeRoutes);
    expect(stdout).toContain("dry-run");
  });

  it("limits backfill to --domain when specified", () => {
    captureOutput(() => runMapBackfill(TMP, false, "cli", false));
    const routes = JSON.parse(readFileSync(join(TMP, ".polaris/map/file-routes.json"), "utf-8"));
    // cli domain file added
    expect(routes["src/cli/version.ts"]).toBeTruthy();
    // map domain file NOT added (filtered out)
    expect(routes["src/map/backfill.ts"]).toBeUndefined();
  });

  it("never overwrites an existing entry in a second run", () => {
    captureOutput(() => runMapBackfill(TMP, false, undefined, false));
    const routesAfterFirst = JSON.parse(readFileSync(join(TMP, ".polaris/map/file-routes.json"), "utf-8"));
    const versionEntry = routesAfterFirst["src/cli/version.ts"];

    captureOutput(() => runMapBackfill(TMP, false, undefined, false));
    const routesAfterSecond = JSON.parse(readFileSync(join(TMP, ".polaris/map/file-routes.json"), "utf-8"));
    expect(routesAfterSecond["src/cli/version.ts"]).toEqual(versionEntry);
  });

  it("errors if atlas is not initialized", () => {
    rmSync(join(TMP, ".polaris/map/file-routes.json"));
    let exited = false;
    const origExit = process.exit.bind(process);
    process.exit = (() => { exited = true; }) as typeof process.exit;
    try {
      captureOutput(() => runMapBackfill(TMP, false, undefined, false));
    } finally {
      process.exit = origExit;
    }
    expect(exited).toBe(true);
  });
});
