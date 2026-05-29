import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { classifyDoc, ingestDocs, CANONICAL_TARGET } from "./ingest.js";

function makeRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "polaris-docs-ingest-"));
  mkdirSync(join(repoRoot, "smartdocs", "docs", "raw"), { recursive: true });
  mkdirSync(join(repoRoot, CANONICAL_TARGET, "doctrine", "active"), { recursive: true });
  mkdirSync(join(repoRoot, ".polaris", "map"), { recursive: true });
  writeFileSync(
    join(repoRoot, "polaris.config.json"),
    JSON.stringify({ repo: { sidecarOutputPath: ".polaris/map" } }),
    "utf-8",
  );
  writeFileSync(
    join(repoRoot, ".polaris", "map", "file-routes.json"),
    JSON.stringify({
      "src/smartdocs-engine/index.ts": {
        domain: "docs",
        route: "src/smartdocs-engine",
        taskchain: "polaris-docs",
        confidence: 0.95,
        classification: "indexed",
        last_updated: "",
        updated_by: "",
        tags: ["docs"],
        instructionFile: "src/smartdocs-engine/POLARIS.md",
      },
    }),
    "utf-8",
  );
  writeFileSync(join(repoRoot, ".polaris", "map", "needs-review.json"), "{}\n", "utf-8");
  return repoRoot;
}

function makeRepoWithoutCanonical(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "polaris-docs-ingest-"));
  mkdirSync(join(repoRoot, ".polaris", "map"), { recursive: true });
  writeFileSync(
    join(repoRoot, "polaris.config.json"),
    JSON.stringify({ repo: { sidecarOutputPath: ".polaris/map" } }),
    "utf-8",
  );
  writeFileSync(join(repoRoot, ".polaris", "map", "file-routes.json"), "{}\n", "utf-8");
  writeFileSync(join(repoRoot, ".polaris", "map", "needs-review.json"), "{}\n", "utf-8");
  return repoRoot;
}

describe("classifyDoc", () => {
  it("classifies docs from explicit content signals", () => {
    expect(classifyDoc("# Runtime Summary\n\nSession summary")).toBe("runtime-summary");
    expect(classifyDoc("# Audit Finding\n\nSecurity audit result")).toBe("audit-finding");
    expect(classifyDoc("# Doctrine\n\nAgents must always preserve state")).toBe("doctrine-candidate");
    expect(classifyDoc("# Feature Spec\n\nAcceptance Criteria")).toBe("spec-raw");
  });

  it("classifies SUMMARY.md as deprecated-noise regardless of content", () => {
    expect(classifyDoc("# Authoritative Doctrine\nAgents must always X.", "SUMMARY.md")).toBe("deprecated-noise");
  });
});

describe("ingestDocs", () => {
  it("rejects SUMMARY.md ingest with a hard guard", () => {
    const repoRoot = makeRepo();
    writeFileSync(join(repoRoot, "SUMMARY.md"), "# Summary\n", "utf-8");

    expect(() => ingestDocs(["SUMMARY.md"], { repoRoot })).toThrow(
      "polaris docs ingest: SUMMARY.md is an endpoint artifact and cannot be ingested",
    );
  });

  it("moves a raw spec, writes provenance, links map area, and emits telemetry", () => {
    const repoRoot = makeRepo();
    writeFileSync(
      join(repoRoot, "smartdocs", "docs", "raw", "ingest-plan.md"),
      "# Ingest Spec\n\nAcceptance Criteria\n\nTouches src/smartdocs-engine/index.ts.",
      "utf-8",
    );

    const [result] = ingestDocs(["smartdocs/docs/raw/ingest-plan.md"], { repoRoot });

    expect(result.classification).toBe("spec-raw");
    expect(result.destinationPath).toBe(`${CANONICAL_TARGET}/raw/ingest-plan.md`);
    expect(result.linkedMapArea).toBe("src/smartdocs-engine");
    expect(existsSync(join(repoRoot, CANONICAL_TARGET, "raw", "ingest-plan.md"))).toBe(true);
    expect(existsSync(join(repoRoot, CANONICAL_TARGET, "raw", "ingest-plan.provenance.json"))).toBe(true);

    // Telemetry written to polaris-docs-ingest path using the generated run_id
    const runsDir = join(repoRoot, ".taskchain_artifacts", "polaris-docs-ingest", "runs");
    expect(existsSync(runsDir)).toBe(true);
    const runDirs = readdirSync(runsDir);
    expect(runDirs).toHaveLength(1);
    const telemetry = readFileSync(join(runsDir, runDirs[0], "telemetry.jsonl"), "utf-8");
    expect(telemetry).toContain('"event":"run-start"');
    expect(telemetry).toContain('"event":"docs-ingest"');

    // run_id in result matches the telemetry dir
    expect(result.runId).toBe(runDirs[0]);
  });

  it("rejects batches above the bounded file limit", () => {
    const repoRoot = makeRepo();
    for (const name of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
      writeFileSync(join(repoRoot, "smartdocs", "docs", "raw", name), "# Spec\n\nAcceptance Criteria", "utf-8");
    }

    expect(() =>
      ingestDocs(
        [
          "smartdocs/docs/raw/a.md",
          "smartdocs/docs/raw/b.md",
          "smartdocs/docs/raw/c.md",
          "smartdocs/docs/raw/d.md",
          "smartdocs/docs/raw/e.md",
        ],
        { repoRoot },
      ),
    ).toThrow("batch limit is 4 files");
  });

  it("does not promote high-authority architecture docs without approval", () => {
    const repoRoot = makeRepo();
    writeFileSync(join(repoRoot, "smartdocs", "docs", "raw", "architecture.md"), "# Architecture\n\nStructural design", "utf-8");

    expect(() => ingestDocs(["smartdocs/docs/raw/architecture.md"], { repoRoot })).toThrow("requires explicit approval");
  });

  it("halts when smartdocs/docs/ canonical target is missing", () => {
    const repoRoot = makeRepoWithoutCanonical();
    writeFileSync(join(repoRoot, "test.md"), "# Spec\n\nAcceptance Criteria", "utf-8");

    expect(() => ingestDocs(["test.md"], { repoRoot })).toThrow("canonical target");
    expect(() => ingestDocs(["test.md"], { repoRoot })).toThrow("smartdocs/docs");
  });

  it("dry-run classifies and reports placement without moving files", () => {
    const repoRoot = makeRepo();
    writeFileSync(
      join(repoRoot, "smartdocs", "docs", "raw", "spec-dry.md"),
      "# Feature Spec\n\nAcceptance Criteria",
      "utf-8",
    );

    const [result] = ingestDocs(["smartdocs/docs/raw/spec-dry.md"], { repoRoot, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.classification).toBe("spec-raw");
    expect(result.destinationPath).toBe(`${CANONICAL_TARGET}/raw/spec-dry.md`);
    expect(result.provenancePath).toBeNull();

    // Source file still exists (not moved)
    expect(existsSync(join(repoRoot, "smartdocs", "docs", "raw", "spec-dry.md"))).toBe(true);
    // Target file does not exist
    expect(existsSync(join(repoRoot, CANONICAL_TARGET, "specs", "raw", "spec-dry.md"))).toBe(false);

    // run-start telemetry still emitted even for dry-run
    const runsDir = join(repoRoot, ".taskchain_artifacts", "polaris-docs-ingest", "runs");
    const runDirs = readdirSync(runsDir);
    expect(runDirs).toHaveLength(1);
    const telemetry = readFileSync(join(runsDir, runDirs[0], "telemetry.jsonl"), "utf-8");
    expect(telemetry).toContain('"event":"run-start"');
  });

  it("halts and emits conflict telemetry when ingested doc contradicts active doctrine", () => {
    const repoRoot = makeRepo();
    // "must preserve" → docRequires captures "preserve"
    // "never preserve" → ingestedProhibits captures "preserve" → conflict
    writeFileSync(
      join(repoRoot, CANONICAL_TARGET, "doctrine", "active", "state-integrity.md"),
      "# State Integrity Doctrine\n\nAgents must preserve telemetry files.\n",
      "utf-8",
    );
    writeFileSync(
      join(repoRoot, "smartdocs", "docs", "raw", "conflicting-doc.md"),
      "# Conflicting Policy\n\nAgents never preserve telemetry files.",
      "utf-8",
    );

    expect(() =>
      ingestDocs(["smartdocs/docs/raw/conflicting-doc.md"], { repoRoot }),
    ).toThrow("conflict detected");

    // Conflict telemetry should be present
    const runsDir = join(repoRoot, ".taskchain_artifacts", "polaris-docs-ingest", "runs");
    const runDirs = readdirSync(runsDir);
    expect(runDirs).toHaveLength(1);
    const telemetry = readFileSync(join(runsDir, runDirs[0], "telemetry.jsonl"), "utf-8");
    expect(telemetry).toContain('"event":"docs-ingest-conflict-detected"');
  });

  it("writes durable state to polaris-docs-ingest after a successful ingest", () => {
    const repoRoot = makeRepo();
    writeFileSync(
      join(repoRoot, "smartdocs", "docs", "raw", "state-test.md"),
      "# Feature Spec\n\nAcceptance Criteria",
      "utf-8",
    );

    const [result] = ingestDocs(["smartdocs/docs/raw/state-test.md"], { repoRoot });

    const stateFile = join(repoRoot, ".taskchain_artifacts", "polaris-docs-ingest", "current-state.json");
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as { run_id: string; status: string; files_ingested: number };
    expect(state.run_id).toBe(result.runId);
    expect(state.status).toBe("complete");
    expect(state.files_ingested).toBe(1);
  });

  it("rejects ignored endpoint artifacts before ingesting and emits telemetry", () => {
    const repoRoot = makeRepo();
    mkdirSync(join(repoRoot, ".taskchain_artifacts", "polaris-run"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json"),
      JSON.stringify({ run_id: "test-run" }),
      "utf-8",
    );

    expect(() =>
      ingestDocs([".taskchain_artifacts/polaris-run/current-state.json"], { repoRoot }),
    ).toThrow("ineligible for docs ingest");

    const runsDir = join(repoRoot, ".taskchain_artifacts", "polaris-docs-ingest", "runs");
    const runDirs = readdirSync(runsDir);
    expect(runDirs).toHaveLength(1);
    const telemetry = readFileSync(join(runsDir, runDirs[0], "telemetry.jsonl"), "utf-8");
    expect(telemetry).toContain('"event":"docs-ingest-skipped-endpoint-artifact"');
    expect(telemetry).toContain('"file":".taskchain_artifacts/polaris-run/current-state.json"');
  });

  it("rejects paths ignored by a custom .smartdocignore pattern", () => {
    const repoRoot = makeRepo();
    mkdirSync(join(repoRoot, "scratch"), { recursive: true });
    writeFileSync(join(repoRoot, ".smartdocignore"), "scratch/*.md\n", "utf-8");
    writeFileSync(join(repoRoot, "scratch", "draft.md"), "# Spec\n\nAcceptance Criteria", "utf-8");

    expect(() => ingestDocs(["scratch/draft.md"], { repoRoot })).toThrow(
      "ignored by .smartdocignore/defaults: scratch/draft.md",
    );
  });
});
