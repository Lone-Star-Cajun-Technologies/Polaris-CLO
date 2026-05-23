import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runMapQuery } from "./query.js";

const TMP = join(process.cwd(), ".test-query-tmp");

const POLARIS_MD_CONTENT = "# Map subsystem instructions\n\nHandle atlas data.";

const ROUTES = {
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
  "src/map/atlas.ts": {
    domain: "map",
    route: "src/map",
    taskchain: "polaris-core",
    confidence: 0.92,
    classification: "indexed" as const,
    last_updated: "2026-05-22T20:00:00Z",
    updated_by: "polaris-map-index",
    tags: ["map"],
    instructionFile: "src/map/POLARIS.md",
  },
};

const NEEDS_REVIEW = {
  "src/map/query.ts": {
    domain: "map",
    route: "src/map",
    taskchain: "polaris-core",
    confidence: 0.6,
    classification: "needs-review" as const,
    last_updated: "2026-05-22T20:00:00Z",
    updated_by: "polaris-map-index",
    tags: ["map"],
  },
};

const EXEMPTIONS = {
  "dist/cli/index.js": { classification: "tracked-not-indexed", reason: "generatedRoots" },
};

const POLARIS_CONFIG = {
  repo: { sidecarOutputPath: ".polaris/map" },
  map: { autoWriteAbove: 0.85, confidenceThreshold: 0.75 },
};

function setup(): void {
  mkdirSync(join(TMP, ".polaris/map"), { recursive: true });
  mkdirSync(join(TMP, "src/cli"), { recursive: true });
  mkdirSync(join(TMP, "src/map"), { recursive: true });
  mkdirSync(join(TMP, "dist/cli"), { recursive: true });
  writeFileSync(join(TMP, "src/cli/index.ts"), "");
  writeFileSync(join(TMP, "src/map/atlas.ts"), "");
  writeFileSync(join(TMP, "src/map/POLARIS.md"), POLARIS_MD_CONTENT);
  writeFileSync(join(TMP, ".polaris/map/file-routes.json"), JSON.stringify(ROUTES));
  writeFileSync(join(TMP, ".polaris/map/needs-review.json"), JSON.stringify(NEEDS_REVIEW));
  writeFileSync(join(TMP, ".polaris/map/exemptions.json"), JSON.stringify(EXEMPTIONS));
  writeFileSync(join(TMP, ".polaris/map/index.json"), JSON.stringify({ scan_date: "", file_count: 0, coverage_pct: 0, entries: {} }));
  writeFileSync(join(TMP, "polaris.config.json"), JSON.stringify(POLARIS_CONFIG));
  writeFileSync(join(TMP, ".polarisignore"), ".env\n*.log\n");
}

function teardown(): void {
  rmSync(TMP, { recursive: true, force: true });
}

function captureOutput(fn: () => void): { stdout: string; stderr: string } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

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

describe("runMapQuery", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("returns indexed metadata for an exact file lookup", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "src/cli/index.ts", undefined, undefined, false));
    const result = JSON.parse(stdout);
    expect(result["src/cli/index.ts"].classification).toBe("indexed");
    expect(result["src/cli/index.ts"].domain).toBe("cli");
    expect(result["src/cli/index.ts"].taskchain).toBe("polaris-cli");
  });

  it("returns ignored classification for a .polarisignore-matched file", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, ".env", undefined, undefined, false));
    const result = JSON.parse(stdout);
    expect(result[".env"].classification).toBe("ignored");
  });

  it("returns unmapped for a file not in the atlas", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "src/cli/unknown.ts", undefined, undefined, false));
    const result = JSON.parse(stdout);
    expect(result["src/cli/unknown.ts"].classification).toBe("unmapped");
  });

  it("returns tracked-not-indexed for an exempted file", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "dist/cli/index.js", undefined, undefined, false));
    const result = JSON.parse(stdout);
    expect(result["dist/cli/index.js"].classification).toBe("tracked-not-indexed");
  });

  it("matches all .ts files in src/ with a glob", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "src/**/*.ts", undefined, undefined, false));
    const result = JSON.parse(stdout);
    expect(Object.keys(result)).toContain("src/cli/index.ts");
    expect(Object.keys(result)).toContain("src/map/atlas.ts");
    expect(Object.keys(result)).toContain("src/map/query.ts");
  });

  it("filters by domain", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, undefined, "cli", undefined, false));
    const result = JSON.parse(stdout);
    expect(Object.keys(result)).toContain("src/cli/index.ts");
    expect(Object.keys(result)).not.toContain("src/map/atlas.ts");
  });

  it("filters by taskchain", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, undefined, undefined, "polaris-core", false));
    const result = JSON.parse(stdout);
    expect(Object.keys(result)).toContain("src/map/atlas.ts");
    expect(Object.keys(result)).toContain("src/map/query.ts");
    expect(Object.keys(result)).not.toContain("src/cli/index.ts");
  });

  it("returns all files in a directory with trailing slash", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "src/map/", undefined, undefined, false));
    const result = JSON.parse(stdout);
    expect(Object.keys(result)).toContain("src/map/atlas.ts");
    expect(Object.keys(result)).toContain("src/map/query.ts");
    expect(Object.keys(result)).not.toContain("src/cli/index.ts");
  });

  it("emits --text output with classification and metadata", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "src/cli/index.ts", undefined, undefined, true));
    expect(stdout).toContain("src/cli/index.ts");
    expect(stdout).toContain("indexed");
    expect(stdout).toContain("domain:cli");
  });

  it("warns when file does not exist in repo", () => {
    const { stderr } = captureOutput(() => runMapQuery(TMP, "does/not/exist.ts", undefined, undefined, false));
    expect(stderr).toContain("warn: file does not exist in repo");
  });

  it("includes instructionFile path in output when entry has one", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "src/map/atlas.ts", undefined, undefined, false));
    const result = JSON.parse(stdout);
    expect(result["src/map/atlas.ts"].instructionFile).toBe("src/map/POLARIS.md");
  });

  it("--include-instructions adds instructionContent to output", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "src/map/atlas.ts", undefined, undefined, false, true));
    const result = JSON.parse(stdout);
    expect(result["src/map/atlas.ts"].instructionFile).toBe("src/map/POLARIS.md");
    expect(result["src/map/atlas.ts"].instructionContent).toBe(POLARIS_MD_CONTENT);
  });

  it("--include-instructions includes instructionFile in --text output", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "src/map/atlas.ts", undefined, undefined, true, false));
    expect(stdout).toContain("instructions:src/map/POLARIS.md");
  });

  it("entry without instructionFile omits field even with --include-instructions", () => {
    const { stdout } = captureOutput(() => runMapQuery(TMP, "src/cli/index.ts", undefined, undefined, false, true));
    const result = JSON.parse(stdout);
    expect(result["src/cli/index.ts"].instructionFile).toBeUndefined();
    expect(result["src/cli/index.ts"].instructionContent).toBeUndefined();
  });
});
