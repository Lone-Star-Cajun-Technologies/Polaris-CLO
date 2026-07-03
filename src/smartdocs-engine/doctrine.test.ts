import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach } from "vitest";
import {
  CANDIDATE_MARKER,
  doctrineDraft,
  doctrineDeprecate,
  doctrinePromote,
  addCandidateGovernanceMetadata,
  parseFrontMatter,
  specPromote,
  migrateProvenance,
  detectDoctrineSupersession,
} from "./doctrine.js";

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "polaris-doctrine-"));
  mkdirSync(join(root, "smartdocs", "raw"), { recursive: true });
  mkdirSync(join(root, "smartdocs", "doctrine", "candidate"), { recursive: true });
  mkdirSync(join(root, "smartdocs", "doctrine", "active"), { recursive: true });
  mkdirSync(join(root, "smartdocs", "doctrine", "deprecated"), { recursive: true });
  mkdirSync(join(root, "smartdocs", "specs", "active"), { recursive: true });
  return root;
}

function todayHeading(): string {
  return `## ${new Date().toISOString().slice(0, 10)}`;
}

describe("doctrineDraft", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("moves a file from smartdocs/raw/ to smartdocs/doctrine/candidate/ with candidate marker", () => {
    const source = join(repoRoot, "smartdocs", "raw", "some-doc.md");
    writeFileSync(source, "# Some Doc\n\nContent here.");

    const result = doctrineDraft(source, { repoRoot, runId: "test-run-001" });

    expect(result.destination).toBe(join(repoRoot, "smartdocs", "doctrine", "candidate", "some-doc.md"));
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(source)).toBe(false);

    const content = readFileSync(result.destination, "utf-8");
    expect(content.startsWith(CANDIDATE_MARKER)).toBe(true);
    expect(content).toContain("# Some Doc");
  });


  it("emits a doctrine-draft event to lifecycle.jsonl", () => {
    const source = join(repoRoot, "smartdocs", "raw", "event-doc.md");
    writeFileSync(source, "# Event Doc");

    const result = doctrineDraft(source, { repoRoot, runId: "test-run-001" });

    expect(existsSync(result.lifecyclePath)).toBe(true);
    const event = JSON.parse(readFileSync(result.lifecyclePath, "utf-8").trim().split("\n")[0]);
    expect(event.event).toBe("doctrine-draft");
    expect(event.run_id).toBe("test-run-001");
    expect(event.source).toBe(source);
    expect(event.destination).toBe(result.destination);
  });

  it("throws if source does not exist", () => {
    expect(() =>
      doctrineDraft(join(repoRoot, "smartdocs", "raw", "nonexistent.md"), { repoRoot }),
    ).toThrow("Source file not found");
  });

  it("throws if source is not in smartdocs/raw/", () => {
    const source = join(repoRoot, "smartdocs", "doctrine", "active", "wrong.md");
    writeFileSync(source, "# Wrong location");

    expect(() => doctrineDraft(source, { repoRoot })).toThrow(
      "doctrineDraft source must be in smartdocs/raw/",
    );
  });

  it("throws if destination already exists", () => {
    const source = join(repoRoot, "smartdocs", "raw", "dupe.md");
    writeFileSync(source, "# Dupe");
    const dest = join(repoRoot, "smartdocs", "doctrine", "candidate", "dupe.md");
    writeFileSync(dest, "# Already there");

    expect(() => doctrineDraft(source, { repoRoot })).toThrow("Destination already exists");
  });

  it("creates log.md with default reason when none is provided", () => {
    const source = join(repoRoot, "smartdocs", "raw", "log-default.md");
    writeFileSync(source, "# Log Default");

    const result = doctrineDraft(source, { repoRoot, runId: "test-run-log-001" });

    const logPath = join(repoRoot, "smartdocs", "doctrine", "candidate", "log.md");
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain("# Directory Update Log");
    expect(logContent).toContain(todayHeading());
    expect(logContent).toContain("**Draft**: log-default.md drafted to doctrine/candidate/");
  });

  it("appends an explicit reason to an existing log.md", () => {
    const source = join(repoRoot, "smartdocs", "raw", "log-explicit.md");
    writeFileSync(source, "# Log Explicit");
    const logPath = join(repoRoot, "smartdocs", "doctrine", "candidate", "log.md");
    writeFileSync(logPath, "# Directory Update Log\n\n## 2020-01-01\n**Draft**: older entry\n");

    const result = doctrineDraft(source, {
      repoRoot,
      runId: "test-run-log-002",
      reason: "Custom draft rationale",
    });

    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent.indexOf(todayHeading())).toBeLessThan(logContent.indexOf("## 2020-01-01"));
    expect(logContent).toContain("**Draft**: Custom draft rationale");
    expect(logContent).toContain("**Draft**: older entry");
  });
});

describe("doctrinePromote", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  const governanceFrontMatter = [
    "---",
    "status: candidate",
    "doc-type: doctrine",
    "confidence: 0.9",
    "recommended-action: promote",
    "overlap-analysis: none",
    "---",
    "",
  ].join("\n");

  it("moves a file from candidate/ to active/ and strips the candidate marker", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "my-doctrine.md");
    writeFileSync(
      candidatePath,
      `${CANDIDATE_MARKER}\n${governanceFrontMatter}# My Doctrine\n\nContent.`,
    );

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-002" });

    expect(result.destination).toBe(
      join(repoRoot, "smartdocs", "doctrine", "active", "my-doctrine.md"),
    );
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(candidatePath)).toBe(false);

    const content = readFileSync(result.destination, "utf-8");
    expect(content).not.toContain(CANDIDATE_MARKER);
    expect(content).toContain("# My Doctrine");
  });

  it("emits a doctrine-promote event to lifecycle.jsonl", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "promoted.md");
    writeFileSync(
      candidatePath,
      `${CANDIDATE_MARKER}\n${governanceFrontMatter}# Promoted`,
    );

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-002" });

    const lines = readFileSync(result.lifecyclePath, "utf-8").trim().split("\n");
    const promoteEvent = lines.map((l) => JSON.parse(l)).find((e) => e.event === "doctrine-promote");
    expect(promoteEvent).toBeDefined();
    expect(promoteEvent.event).toBe("doctrine-promote");
    expect(promoteEvent.run_id).toBe("test-run-002");
  });

  it("throws if source is not in smartdocs/doctrine/candidate/", () => {
    const source = join(repoRoot, "smartdocs", "raw", "wrong.md");
    writeFileSync(source, `${CANDIDATE_MARKER}\n# Wrong`);

    expect(() => doctrinePromote(source, { repoRoot })).toThrow(
      "doctrinePromote source must be in smartdocs/doctrine/candidate/",
    );
  });

  it("throws if file is missing the candidate marker", () => {
    const source = join(repoRoot, "smartdocs", "doctrine", "candidate", "unmarked.md");
    writeFileSync(source, "# No marker");

    expect(() => doctrinePromote(source, { repoRoot })).toThrow("not in candidate state");
  });

  it("throws if source does not exist", () => {
    expect(() =>
      doctrinePromote(
        join(repoRoot, "smartdocs", "doctrine", "candidate", "ghost.md"),
        { repoRoot },
      ),
    ).toThrow("Source file not found");
  });

  it("rejects file missing governance fields", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "no-gov.md");
    writeFileSync(candidatePath, `${CANDIDATE_MARKER}\n# Missing governance`);

    expect(() => doctrinePromote(candidatePath, { repoRoot })).toThrow(
      'missing required governance field "doc-type"',
    );
  });

  it("rejects file with recommended-action: hold", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "on-hold.md");
    const content = [
      CANDIDATE_MARKER,
      "---",
      "doc-type: doctrine",
      "confidence: 0.5",
      "recommended-action: hold",
      "overlap-analysis: none",
      "---",
      "",
      "# On hold",
    ].join("\n");
    writeFileSync(candidatePath, content);

    expect(() => doctrinePromote(candidatePath, { repoRoot })).toThrow(
      'recommended-action must be "promote" but got "hold"',
    );
  });

  it("succeeds with all required governance fields present", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "governed.md");
    const content = [
      CANDIDATE_MARKER,
      "---",
      "doc-type: doctrine",
      "confidence: 0.95",
      "recommended-action: promote",
      "overlap-analysis: none",
      "---",
      "",
      "# Governed doc",
    ].join("\n");
    writeFileSync(candidatePath, content);

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-gov" });
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(candidatePath)).toBe(false);
  });

  it("moves co-located .provenance.json sidecar alongside the .md", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "with-prov.md");
    const provenanceSrc = join(repoRoot, "smartdocs", "doctrine", "candidate", "with-prov.provenance.json");
    const content = [
      CANDIDATE_MARKER,
      "---",
      "doc-type: doctrine",
      "confidence: 0.9",
      "recommended-action: promote",
      "overlap-analysis: none",
      "---",
      "",
      "# With Provenance",
    ].join("\n");
    writeFileSync(candidatePath, content);
    writeFileSync(provenanceSrc, JSON.stringify({ classifiedAs: "doctrine-candidate" }));

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-prov" });

    const provenanceDest = result.destination.replace(/\.md$/, ".provenance.json");
    expect(existsSync(provenanceDest)).toBe(true);
    expect(existsSync(provenanceSrc)).toBe(false);
  });

  it("succeeds without error when no .provenance.json sidecar exists", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "no-prov.md");
    const content = [
      CANDIDATE_MARKER,
      "---",
      "doc-type: doctrine",
      "confidence: 0.9",
      "recommended-action: promote",
      "overlap-analysis: none",
      "---",
      "",
      "# No Provenance",
    ].join("\n");
    writeFileSync(candidatePath, content);

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-noprov" });
    expect(existsSync(result.destination)).toBe(true);
  });

  it("emits audit.jsonl event on successful promotion", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "audited.md");
    const content = [
      CANDIDATE_MARKER,
      "---",
      "doc-type: doctrine",
      "confidence: 0.9",
      "recommended-action: promote",
      "overlap-analysis: minimal overlap with existing docs",
      "---",
      "",
      "# Audited doc",
    ].join("\n");
    writeFileSync(candidatePath, content);

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-audit" });

    const auditPath = join(
      repoRoot,
      ".taskchain_artifacts",
      "polaris-doctrine",
      "test-run-audit",
      "audit.jsonl",
    );
    expect(existsSync(auditPath)).toBe(true);
    const auditEvent = JSON.parse(readFileSync(auditPath, "utf-8").trim());
    expect(auditEvent.event).toBe("doctrine-promoted");
    expect(auditEvent.run_id).toBe("test-run-audit");
    expect(auditEvent.doc_type).toBe("doctrine");
    expect(auditEvent.confidence).toBe(0.9);
    expect(auditEvent.recommended_action).toBe("promote");
    expect(auditEvent.overlap_analysis).toBe("minimal overlap with existing docs");
    expect(auditEvent.promoted_by).toBe("polaris-cli");
    expect(result.destination).toBeDefined();
  });

  it("creates log.md in active directory with default reason", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "log-promote-default.md");
    const content = [
      CANDIDATE_MARKER,
      "---",
      "doc-type: doctrine",
      "confidence: 0.9",
      "recommended-action: promote",
      "overlap-analysis: none",
      "---",
      "",
      "# Log Promote Default",
    ].join("\n");
    writeFileSync(candidatePath, content);

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-promote-log" });

    const logPath = join(repoRoot, "smartdocs", "doctrine", "active", "log.md");
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain("# Directory Update Log");
    expect(logContent).toContain(todayHeading());
    expect(logContent).toContain("**Promote**: log-promote-default.md promoted to doctrine/active/");
  });

  it("appends explicit reason to existing log.md", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "log-promote-explicit.md");
    const content = [
      CANDIDATE_MARKER,
      "---",
      "doc-type: doctrine",
      "confidence: 0.9",
      "recommended-action: promote",
      "overlap-analysis: none",
      "---",
      "",
      "# Log Promote Explicit",
    ].join("\n");
    writeFileSync(candidatePath, content);
    const logPath = join(repoRoot, "smartdocs", "doctrine", "active", "log.md");
    writeFileSync(logPath, "# Directory Update Log\n\n## 2020-01-01\n**Promote**: older\n");

    const result = doctrinePromote(candidatePath, {
      repoRoot,
      runId: "test-run-promote-log-explicit",
      reason: "Approved by architecture review",
    });

    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent.indexOf(todayHeading())).toBeLessThan(logContent.indexOf("## 2020-01-01"));
    expect(logContent).toContain("**Promote**: Approved by architecture review");
    expect(logContent).toContain("**Promote**: older");
  });
});

describe("addCandidateGovernanceMetadata", () => {
  it("adds governance fields to content without front matter", () => {
    const result = addCandidateGovernanceMetadata("# Hello", "doctrine");
    expect(result).toContain("doc-type: doctrine");
    expect(result).toContain("confidence: 0.0");
    expect(result).toContain("recommended-action: hold");
    expect(result).toContain("overlap-analysis: pending");
    expect(result).toContain("# Hello");
  });

  it("merges governance fields into existing front matter without overwriting existing keys", () => {
    const content = "---\nstatus: candidate\ndoc-type: existing-type\n---\n\n# Hello";
    const result = addCandidateGovernanceMetadata(content, "doctrine");
    expect(result).toContain("doc-type: existing-type");
    expect(result).not.toContain("doc-type: doctrine");
    expect(result).toContain("confidence: 0.0");
    expect(result).toContain("recommended-action: hold");
    expect(result).toContain("overlap-analysis: pending");
  });

  it("does not modify content when all governance and relationship fields already present", () => {
    const content = [
      "---",
      "doc-type: doctrine",
      "confidence: 0.9",
      "recommended-action: promote",
      "overlap-analysis: none",
      "implements: ",
      "related: ",
      "supersedes: ",
      "superseded_by: ",
      "depends_on: ",
      "validates: ",
      "source_paths: ",
      "---",
      "",
      "# Hello",
    ].join("\n");
    const result = addCandidateGovernanceMetadata(content, "other");
    expect(result).toBe(content);
  });

  it("adds relationship scaffolding fields when only core governance fields are present", () => {
    const content = [
      "---",
      "doc-type: doctrine",
      "confidence: 0.9",
      "recommended-action: promote",
      "overlap-analysis: none",
      "---",
      "",
      "# Hello",
    ].join("\n");
    const result = addCandidateGovernanceMetadata(content, "other");
    expect(result).toContain("implements: ");
    expect(result).toContain("source_paths: ");
    expect(result).not.toContain("doc-type: other");
  });
});

describe("parseFrontMatter", () => {
  it("parses governance and relationship fields from candidate content", () => {
    const content = [
      CANDIDATE_MARKER,
      "---",
      "doc-type: doctrine",
      "confidence: 0.9",
      "recommended-action: promote",
      "overlap-analysis: none",
      "implements: POL-234",
      "related: smartdocs-summary-architecture",
      "supersedes: old-doc",
      "superseded_by: new-doc",
      "depends_on: map-route-normalization",
      "validates: POL-234",
      "source_paths: src/smartdocs-engine/doctrine.ts,src/cognition/summary-delta.ts",
      "---",
      "",
      "# Candidate",
    ].join("\n");

    expect(parseFrontMatter(content)).toMatchObject({
      "doc-type": "doctrine",
      confidence: "0.9",
      "recommended-action": "promote",
      "overlap-analysis": "none",
      implements: "POL-234",
      related: "smartdocs-summary-architecture",
      supersedes: "old-doc",
      superseded_by: "new-doc",
      depends_on: "map-route-normalization",
      validates: "POL-234",
      source_paths: "src/smartdocs-engine/doctrine.ts,src/cognition/summary-delta.ts",
    });
  });

  it("returns an empty object when no frontmatter is present", () => {
    expect(parseFrontMatter("# No frontmatter")).toEqual({});
  });
});

describe("doctrineDeprecate", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("moves a file from active/ to deprecated/ with deprecation provenance header", () => {
    const activePath = join(repoRoot, "smartdocs", "doctrine", "active", "old-doctrine.md");
    writeFileSync(activePath, "# Old Doctrine\n\nOriginal content.");

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-003" });

    expect(result.destination).toBe(
      join(repoRoot, "smartdocs", "doctrine", "deprecated", "old-doctrine.md"),
    );
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(activePath)).toBe(false);

    const content = readFileSync(result.destination, "utf-8");
    expect(content).toContain("polaris:doctrine-deprecated");
    expect(content).toContain("# Old Doctrine");
  });

  it("emits a doctrine-deprecate event to lifecycle.jsonl", () => {
    const activePath = join(repoRoot, "smartdocs", "doctrine", "active", "deprecated.md");
    writeFileSync(activePath, "# Deprecated");

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-003" });

    const event = JSON.parse(readFileSync(result.lifecyclePath, "utf-8").trim().split("\n")[0]);
    expect(event.event).toBe("doctrine-deprecate");
    expect(event.run_id).toBe("test-run-003");
    expect(event.deprecated_at).toBeDefined();
  });

  it("throws if source is not in smartdocs/doctrine/active/", () => {
    const source = join(repoRoot, "smartdocs", "doctrine", "candidate", "wrong.md");
    writeFileSync(source, `${CANDIDATE_MARKER}\n# Wrong`);

    expect(() => doctrineDeprecate(source, { repoRoot })).toThrow(
      "doctrineDeprecate source must be in smartdocs/doctrine/active/",
    );
  });

  it("throws if source does not exist", () => {
    expect(() =>
      doctrineDeprecate(
        join(repoRoot, "smartdocs", "doctrine", "active", "ghost.md"),
        { repoRoot },
      ),
    ).toThrow("Source file not found");
  });

  it("moves co-located .provenance.json sidecar alongside the .md", () => {
    const activePath = join(repoRoot, "smartdocs", "doctrine", "active", "prov-dep.md");
    const provenanceSrc = join(repoRoot, "smartdocs", "doctrine", "active", "prov-dep.provenance.json");
    writeFileSync(activePath, "# Prov Dep\n\nContent.");
    writeFileSync(provenanceSrc, JSON.stringify({ classifiedAs: "doctrine-candidate" }));

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-dep-prov" });

    const provenanceDest = result.destination.replace(/\.md$/, ".provenance.json");
    expect(existsSync(provenanceDest)).toBe(true);
    expect(existsSync(provenanceSrc)).toBe(false);
  });

  it("succeeds without error when no .provenance.json sidecar exists", () => {
    const activePath = join(repoRoot, "smartdocs", "doctrine", "active", "no-prov-dep.md");
    writeFileSync(activePath, "# No Prov\n\nContent.");

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-dep-noprov" });
    expect(existsSync(result.destination)).toBe(true);
  });

  it("creates log.md in deprecated directory with default reason", () => {
    const activePath = join(repoRoot, "smartdocs", "doctrine", "active", "log-dep-default.md");
    writeFileSync(activePath, "# Log Dep Default");

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-dep-log" });

    const logPath = join(repoRoot, "smartdocs", "doctrine", "deprecated", "log.md");
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain("# Directory Update Log");
    expect(logContent).toContain(todayHeading());
    expect(logContent).toContain("**Deprecate**: log-dep-default.md deprecated to doctrine/deprecated/");
  });

  it("appends explicit reason to existing log.md", () => {
    const activePath = join(repoRoot, "smartdocs", "doctrine", "active", "log-dep-explicit.md");
    writeFileSync(activePath, "# Log Dep Explicit");
    const logPath = join(repoRoot, "smartdocs", "doctrine", "deprecated", "log.md");
    writeFileSync(logPath, "# Directory Update Log\n\n## 2020-01-01\n**Deprecate**: older\n");

    const result = doctrineDeprecate(activePath, {
      repoRoot,
      runId: "test-run-dep-log-explicit",
      reason: "Superseded by new architecture",
    });

    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent.indexOf(todayHeading())).toBeLessThan(logContent.indexOf("## 2020-01-01"));
    expect(logContent).toContain("**Deprecate**: Superseded by new architecture");
    expect(logContent).toContain("**Deprecate**: older");
  });
});

describe("specPromote", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("promotes a raw spec to specs/active/ with no conflicts", () => {
    const src = join(repoRoot, "smartdocs", "raw", "my-spec.md");
    writeFileSync(src, "# My Spec\n\nThis spec must use the new API.");

    const result = specPromote(src, { repoRoot, runId: "spec-run-001" });

    expect(result.halted).toBe(false);
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(src)).toBe(false);
    expect(result.destination).toContain("specs/active/my-spec.md");
  });

  it("moves co-located .provenance.json sidecar alongside the .md", () => {
    const src = join(repoRoot, "smartdocs", "raw", "prov-spec.md");
    const provSrc = join(repoRoot, "smartdocs", "raw", "prov-spec.provenance.json");
    writeFileSync(src, "# Prov Spec\n\nMust always validate inputs.");
    writeFileSync(provSrc, JSON.stringify({ linkedMapArea: "src/api", classifiedAs: "spec-raw" }));

    const result = specPromote(src, { repoRoot, runId: "spec-run-prov" });

    expect(result.halted).toBe(false);
    const provDest = result.destination.replace(/\.md$/, ".provenance.json");
    expect(existsSync(provDest)).toBe(true);
    expect(existsSync(provSrc)).toBe(false);
  });

  it("halts when incoming content conflicts with an active spec", () => {
    writeFileSync(
      join(repoRoot, "smartdocs", "specs", "active", "existing.md"),
      "# Existing\n\nAgents must always validate inputs.",
    );
    const src = join(repoRoot, "smartdocs", "raw", "conflict-spec.md");
    writeFileSync(src, "# Conflict\n\nAgents must never validate inputs.");

    const result = specPromote(src, { repoRoot, runId: "spec-run-conflict" });

    expect(result.halted).toBe(true);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0].type).toBe("content");
    expect(existsSync(src)).toBe(true);
    expect(result.destination).toBe("");
  });

  it("proceeds past content conflicts when approve is true", () => {
    writeFileSync(
      join(repoRoot, "smartdocs", "specs", "active", "existing.md"),
      "# Existing\n\nAgents must always validate inputs.",
    );
    const src = join(repoRoot, "smartdocs", "raw", "override-spec.md");
    writeFileSync(src, "# Override\n\nAgents must never validate inputs.");

    const result = specPromote(src, { repoRoot, runId: "spec-run-approve", approve: true });

    expect(result.halted).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(existsSync(result.destination)).toBe(true);
  });

  it("halts on map conflict when linkedMapArea already covered by active spec", () => {
    writeFileSync(
      join(repoRoot, "smartdocs", "specs", "active", "api-spec.md"),
      "# API Spec\n\nCovers src/api route logic.",
    );
    const src = join(repoRoot, "smartdocs", "raw", "map-conflict.md");
    const provSrc = join(repoRoot, "smartdocs", "raw", "map-conflict.provenance.json");
    writeFileSync(src, "# Map Conflict\n\nNew spec for the API.");
    writeFileSync(provSrc, JSON.stringify({ linkedMapArea: "src/api", classifiedAs: "spec-raw" }));

    const result = specPromote(src, { repoRoot, runId: "spec-run-map" });

    expect(result.halted).toBe(true);
    const mapConflict = result.conflicts.find((c) => c.type === "map");
    expect(mapConflict).toBeDefined();
  });

  it("throws if source is not in smartdocs/raw/", () => {
    const src = join(repoRoot, "smartdocs", "specs", "active", "wrong.md");
    writeFileSync(src, "# Wrong");

    expect(() => specPromote(src, { repoRoot })).toThrow(
      "specPromote source must be in smartdocs/raw/",
    );
  });

  it("throws if destination already exists", () => {
    const src = join(repoRoot, "smartdocs", "raw", "dupe-spec.md");
    writeFileSync(src, "# Dupe");
    writeFileSync(join(repoRoot, "smartdocs", "specs", "active", "dupe-spec.md"), "# Already there");

    expect(() => specPromote(src, { repoRoot })).toThrow("Destination already exists");
  });

  it("emits lifecycle event on successful promote", () => {
    const src = join(repoRoot, "smartdocs", "raw", "lifecycle-spec.md");
    writeFileSync(src, "# Lifecycle Spec\n\nContent here.");

    const result = specPromote(src, { repoRoot, runId: "spec-lifecycle-001" });

    expect(existsSync(result.lifecyclePath)).toBe(true);
    const event = JSON.parse(readFileSync(result.lifecyclePath, "utf-8").trim().split("\n")[0]);
    expect(event.event).toBe("spec-promote");
    expect(event.run_id).toBe("spec-lifecycle-001");
  });

  it("creates log.md in specs/active with default reason", () => {
    const src = join(repoRoot, "smartdocs", "raw", "log-spec-default.md");
    writeFileSync(src, "# Log Spec Default\n\nNo conflicts.");

    const result = specPromote(src, { repoRoot, runId: "spec-log-001" });

    const logPath = join(repoRoot, "smartdocs", "specs", "active", "log.md");
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain("# Directory Update Log");
    expect(logContent).toContain(todayHeading());
    expect(logContent).toContain("**Promote**: log-spec-default.md promoted to specs/active/");
  });

  it("appends explicit reason to existing log.md", () => {
    const src = join(repoRoot, "smartdocs", "raw", "log-spec-explicit.md");
    writeFileSync(src, "# Log Spec Explicit\n\nNo conflicts.");
    const logPath = join(repoRoot, "smartdocs", "specs", "active", "log.md");
    writeFileSync(logPath, "# Directory Update Log\n\n## 2020-01-01\n**Promote**: older\n");

    const result = specPromote(src, {
      repoRoot,
      runId: "spec-log-002",
      reason: "Approved for v2.0 release",
    });

    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent.indexOf(todayHeading())).toBeLessThan(logContent.indexOf("## 2020-01-01"));
    expect(logContent).toContain("**Promote**: Approved for v2.0 release");
    expect(logContent).toContain("**Promote**: older");
  });

  it("does not write log.md when promotion is halted", () => {
    writeFileSync(
      join(repoRoot, "smartdocs", "specs", "active", "existing-halt.md"),
      "# Existing Halt\n\nAgents must always validate inputs.",
    );
    const src = join(repoRoot, "smartdocs", "raw", "halt-spec.md");
    writeFileSync(src, "# Halt Spec\n\nAgents must never validate inputs.");

    const result = specPromote(src, { repoRoot, runId: "spec-halt-001" });

    expect(result.halted).toBe(true);
    const logPath = join(repoRoot, "smartdocs", "specs", "active", "log.md");
    expect(existsSync(logPath)).toBe(false);
  });
});

describe("migrateProvenance", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("stamps frontmatter into paired .md and deletes the sidecar", () => {
    const mdPath = join(repoRoot, "smartdocs", "doctrine", "active", "some-doc.md");
    const sidecarPath = join(repoRoot, "smartdocs", "doctrine", "active", "some-doc.provenance.json");
    writeFileSync(mdPath, "# Some Doc\n\nContent here.", "utf-8");
    writeFileSync(sidecarPath, JSON.stringify({
      originalPath: "smartdocs/raw/some-doc.md",
      classifiedAs: "doctrine-candidate",
      ingestRunId: "test-run-001",
      ingestClusterId: "POL-001",
      linkedMapArea: "src/loop",
      ingestedAt: "2026-01-01T00:00:00.000Z",
    }), "utf-8");

    const result = migrateProvenance({ repoRoot, runId: "migrate-test-001" });

    expect(result.stamped).toBe(1);
    expect(result.errors).toBe(0);
    expect(existsSync(sidecarPath)).toBe(false);
    const content = readFileSync(mdPath, "utf-8");
    expect(content).toContain("classified-as: doctrine-candidate");
    expect(content).toContain("source: smartdocs/raw/some-doc.md");
    expect(content).toContain("ingest-run-id: test-run-001");
  });

  it("dry-run reports without writing or deleting", () => {
    const mdPath = join(repoRoot, "smartdocs", "doctrine", "active", "dry-doc.md");
    const sidecarPath = join(repoRoot, "smartdocs", "doctrine", "active", "dry-doc.provenance.json");
    const originalContent = "# Dry Doc\n\nContent here.";
    writeFileSync(mdPath, originalContent, "utf-8");
    writeFileSync(sidecarPath, JSON.stringify({ originalPath: "smartdocs/raw/dry-doc.md", classifiedAs: "doctrine-candidate", ingestRunId: "run-x", ingestClusterId: null, linkedMapArea: null, ingestedAt: "2026-01-01T00:00:00.000Z" }), "utf-8");

    const result = migrateProvenance({ repoRoot, dryRun: true, runId: "dry-migrate-001" });

    expect(result.stamped).toBe(0);
    expect(result.records[0].status).toBe("skipped-dry-run");
    expect(existsSync(sidecarPath)).toBe(true);
    expect(readFileSync(mdPath, "utf-8")).toBe(originalContent);
  });

  it("records skipped-no-md for orphaned sidecars", () => {
    const sidecarPath = join(repoRoot, "smartdocs", "doctrine", "active", "orphan.provenance.json");
    writeFileSync(sidecarPath, JSON.stringify({ originalPath: "smartdocs/raw/orphan.md", classifiedAs: "doctrine-candidate", ingestRunId: "run-x", ingestClusterId: null, linkedMapArea: null, ingestedAt: "2026-01-01T00:00:00.000Z" }), "utf-8");

    const result = migrateProvenance({ repoRoot, runId: "orphan-test-001" });

    expect(result.stamped).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.records[0].status).toBe("skipped-no-md");
    expect(existsSync(sidecarPath)).toBe(true);
  });
});

describe("detectDoctrineSupersession", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("returns a suggested-supersession conflict when candidate overlaps heavily with an active doc", () => {
    // Candidate and active share the same modal keywords — identical content → 100% Jaccard
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "new-policy.md");
    writeFileSync(
      candidatePath,
      `${CANDIDATE_MARKER}\n# New Policy\n\nAgents must always validate inputs. Agents must never skip validation.`,
    );
    writeFileSync(
      join(repoRoot, "smartdocs", "doctrine", "active", "old-policy.md"),
      "# Old Policy\n\nAgents must always validate inputs. Agents must never skip validation.",
    );

    const conflicts = detectDoctrineSupersession(candidatePath, { repoRoot });

    expect(conflicts.length).toBe(1);
    expect(conflicts[0].type).toBe("suggested-supersession");
    expect(conflicts[0].conflictingFile).toBe("old-policy.md");
    expect(conflicts[0].detail).toContain("supersedes");
  });

  it("returns no conflicts when candidate has low keyword overlap with active docs", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "unrelated.md");
    writeFileSync(
      candidatePath,
      `${CANDIDATE_MARKER}\n# Unrelated\n\nAgents must always commit changes before merging.`,
    );
    writeFileSync(
      join(repoRoot, "smartdocs", "doctrine", "active", "other-policy.md"),
      "# Other Policy\n\nAgents must never expose secrets. Agents must always rotate tokens.",
    );

    const conflicts = detectDoctrineSupersession(candidatePath, { repoRoot });

    expect(conflicts.length).toBe(0);
  });

  it("returns no conflicts when doctrine/active/ has no documents", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "lonely.md");
    writeFileSync(
      candidatePath,
      `${CANDIDATE_MARKER}\n# Lonely\n\nAgents must always validate inputs.`,
    );
    // active/ directory exists but is empty (created by makeTempDir)

    const conflicts = detectDoctrineSupersession(candidatePath, { repoRoot });

    expect(conflicts.length).toBe(0);
  });

  it("does not write supersedes/superseded_by frontmatter — report only", () => {
    const candidatePath = join(repoRoot, "smartdocs", "doctrine", "candidate", "check-fm.md");
    const originalContent = `${CANDIDATE_MARKER}\n# Check FM\n\nAgents must always validate inputs. Agents must never skip validation.`;
    writeFileSync(candidatePath, originalContent);
    writeFileSync(
      join(repoRoot, "smartdocs", "doctrine", "active", "base.md"),
      "# Base\n\nAgents must always validate inputs. Agents must never skip validation.",
    );

    detectDoctrineSupersession(candidatePath, { repoRoot });

    // Candidate file must be unchanged
    expect(readFileSync(candidatePath, "utf-8")).toBe(originalContent);
    // Active file must be unchanged
    const activeContent = readFileSync(
      join(repoRoot, "smartdocs", "doctrine", "active", "base.md"),
      "utf-8",
    );
    expect(activeContent).not.toContain("supersedes");
    expect(activeContent).not.toContain("superseded_by");
  });
});
