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
  specPromote,
} from "./doctrine.js";

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "polaris-doctrine-"));
  mkdirSync(join(root, "smartdocs", "docs", "raw"), { recursive: true });
  mkdirSync(join(root, "smartdocs", "docs", "doctrine", "candidate"), { recursive: true });
  mkdirSync(join(root, "smartdocs", "docs", "doctrine", "active"), { recursive: true });
  mkdirSync(join(root, "smartdocs", "docs", "doctrine", "deprecated"), { recursive: true });
  mkdirSync(join(root, "smartdocs", "docs", "specs", "active"), { recursive: true });
  return root;
}

describe("doctrineDraft", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("moves a file from smartdocs/docs/raw/ to smartdocs/docs/doctrine/candidate/ with candidate marker", () => {
    const source = join(repoRoot, "smartdocs", "docs", "raw", "some-doc.md");
    writeFileSync(source, "# Some Doc\n\nContent here.");

    const result = doctrineDraft(source, { repoRoot, runId: "test-run-001" });

    expect(result.destination).toBe(join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "some-doc.md"));
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(source)).toBe(false);

    const content = readFileSync(result.destination, "utf-8");
    expect(content.startsWith(CANDIDATE_MARKER)).toBe(true);
    expect(content).toContain("# Some Doc");
  });


  it("emits a doctrine-draft event to lifecycle.jsonl", () => {
    const source = join(repoRoot, "smartdocs", "docs", "raw", "event-doc.md");
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
      doctrineDraft(join(repoRoot, "smartdocs", "docs", "raw", "nonexistent.md"), { repoRoot }),
    ).toThrow("Source file not found");
  });

  it("throws if source is not in smartdocs/docs/raw/", () => {
    const source = join(repoRoot, "smartdocs", "docs", "doctrine", "active", "wrong.md");
    writeFileSync(source, "# Wrong location");

    expect(() => doctrineDraft(source, { repoRoot })).toThrow(
      "doctrineDraft source must be in smartdocs/docs/raw/",
    );
  });

  it("throws if destination already exists", () => {
    const source = join(repoRoot, "smartdocs", "docs", "raw", "dupe.md");
    writeFileSync(source, "# Dupe");
    const dest = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "dupe.md");
    writeFileSync(dest, "# Already there");

    expect(() => doctrineDraft(source, { repoRoot })).toThrow("Destination already exists");
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
    const candidatePath = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "my-doctrine.md");
    writeFileSync(
      candidatePath,
      `${CANDIDATE_MARKER}\n${governanceFrontMatter}# My Doctrine\n\nContent.`,
    );

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-002" });

    expect(result.destination).toBe(
      join(repoRoot, "smartdocs", "docs", "doctrine", "active", "my-doctrine.md"),
    );
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(candidatePath)).toBe(false);

    const content = readFileSync(result.destination, "utf-8");
    expect(content).not.toContain(CANDIDATE_MARKER);
    expect(content).toContain("# My Doctrine");
  });

  it("emits a doctrine-promote event to lifecycle.jsonl", () => {
    const candidatePath = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "promoted.md");
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

  it("throws if source is not in smartdocs/docs/doctrine/candidate/", () => {
    const source = join(repoRoot, "smartdocs", "docs", "raw", "wrong.md");
    writeFileSync(source, `${CANDIDATE_MARKER}\n# Wrong`);

    expect(() => doctrinePromote(source, { repoRoot })).toThrow(
      "doctrinePromote source must be in smartdocs/docs/doctrine/candidate/",
    );
  });

  it("throws if file is missing the candidate marker", () => {
    const source = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "unmarked.md");
    writeFileSync(source, "# No marker");

    expect(() => doctrinePromote(source, { repoRoot })).toThrow("not in candidate state");
  });

  it("throws if source does not exist", () => {
    expect(() =>
      doctrinePromote(
        join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "ghost.md"),
        { repoRoot },
      ),
    ).toThrow("Source file not found");
  });

  it("rejects file missing governance fields", () => {
    const candidatePath = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "no-gov.md");
    writeFileSync(candidatePath, `${CANDIDATE_MARKER}\n# Missing governance`);

    expect(() => doctrinePromote(candidatePath, { repoRoot })).toThrow(
      'missing required governance field "doc-type"',
    );
  });

  it("rejects file with recommended-action: hold", () => {
    const candidatePath = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "on-hold.md");
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
    const candidatePath = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "governed.md");
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
    const candidatePath = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "with-prov.md");
    const provenanceSrc = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "with-prov.provenance.json");
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
    const candidatePath = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "no-prov.md");
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
    const candidatePath = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "audited.md");
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

  it("does not modify content when all governance fields already present", () => {
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
    expect(result).toBe(content);
  });
});

describe("doctrineDeprecate", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("moves a file from active/ to deprecated/ with deprecation provenance header", () => {
    const activePath = join(repoRoot, "smartdocs", "docs", "doctrine", "active", "old-doctrine.md");
    writeFileSync(activePath, "# Old Doctrine\n\nOriginal content.");

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-003" });

    expect(result.destination).toBe(
      join(repoRoot, "smartdocs", "docs", "doctrine", "deprecated", "old-doctrine.md"),
    );
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(activePath)).toBe(false);

    const content = readFileSync(result.destination, "utf-8");
    expect(content).toContain("polaris:doctrine-deprecated");
    expect(content).toContain("# Old Doctrine");
  });

  it("emits a doctrine-deprecate event to lifecycle.jsonl", () => {
    const activePath = join(repoRoot, "smartdocs", "docs", "doctrine", "active", "deprecated.md");
    writeFileSync(activePath, "# Deprecated");

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-003" });

    const event = JSON.parse(readFileSync(result.lifecyclePath, "utf-8").trim().split("\n")[0]);
    expect(event.event).toBe("doctrine-deprecate");
    expect(event.run_id).toBe("test-run-003");
    expect(event.deprecated_at).toBeDefined();
  });

  it("throws if source is not in smartdocs/docs/doctrine/active/", () => {
    const source = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate", "wrong.md");
    writeFileSync(source, `${CANDIDATE_MARKER}\n# Wrong`);

    expect(() => doctrineDeprecate(source, { repoRoot })).toThrow(
      "doctrineDeprecate source must be in smartdocs/docs/doctrine/active/",
    );
  });

  it("throws if source does not exist", () => {
    expect(() =>
      doctrineDeprecate(
        join(repoRoot, "smartdocs", "docs", "doctrine", "active", "ghost.md"),
        { repoRoot },
      ),
    ).toThrow("Source file not found");
  });

  it("moves co-located .provenance.json sidecar alongside the .md", () => {
    const activePath = join(repoRoot, "smartdocs", "docs", "doctrine", "active", "prov-dep.md");
    const provenanceSrc = join(repoRoot, "smartdocs", "docs", "doctrine", "active", "prov-dep.provenance.json");
    writeFileSync(activePath, "# Prov Dep\n\nContent.");
    writeFileSync(provenanceSrc, JSON.stringify({ classifiedAs: "doctrine-candidate" }));

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-dep-prov" });

    const provenanceDest = result.destination.replace(/\.md$/, ".provenance.json");
    expect(existsSync(provenanceDest)).toBe(true);
    expect(existsSync(provenanceSrc)).toBe(false);
  });

  it("succeeds without error when no .provenance.json sidecar exists", () => {
    const activePath = join(repoRoot, "smartdocs", "docs", "doctrine", "active", "no-prov-dep.md");
    writeFileSync(activePath, "# No Prov\n\nContent.");

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-dep-noprov" });
    expect(existsSync(result.destination)).toBe(true);
  });
});

describe("specPromote", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("promotes a raw spec to specs/active/ with no conflicts", () => {
    const src = join(repoRoot, "smartdocs", "docs", "raw", "my-spec.md");
    writeFileSync(src, "# My Spec\n\nThis spec must use the new API.");

    const result = specPromote(src, { repoRoot, runId: "spec-run-001" });

    expect(result.halted).toBe(false);
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(src)).toBe(false);
    expect(result.destination).toContain("specs/active/my-spec.md");
  });

  it("moves co-located .provenance.json sidecar alongside the .md", () => {
    const src = join(repoRoot, "smartdocs", "docs", "raw", "prov-spec.md");
    const provSrc = join(repoRoot, "smartdocs", "docs", "raw", "prov-spec.provenance.json");
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
      join(repoRoot, "smartdocs", "docs", "specs", "active", "existing.md"),
      "# Existing\n\nAgents must always validate inputs.",
    );
    const src = join(repoRoot, "smartdocs", "docs", "raw", "conflict-spec.md");
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
      join(repoRoot, "smartdocs", "docs", "specs", "active", "existing.md"),
      "# Existing\n\nAgents must always validate inputs.",
    );
    const src = join(repoRoot, "smartdocs", "docs", "raw", "override-spec.md");
    writeFileSync(src, "# Override\n\nAgents must never validate inputs.");

    const result = specPromote(src, { repoRoot, runId: "spec-run-approve", approve: true });

    expect(result.halted).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(existsSync(result.destination)).toBe(true);
  });

  it("halts on map conflict when linkedMapArea already covered by active spec", () => {
    writeFileSync(
      join(repoRoot, "smartdocs", "docs", "specs", "active", "api-spec.md"),
      "# API Spec\n\nCovers src/api route logic.",
    );
    const src = join(repoRoot, "smartdocs", "docs", "raw", "map-conflict.md");
    const provSrc = join(repoRoot, "smartdocs", "docs", "raw", "map-conflict.provenance.json");
    writeFileSync(src, "# Map Conflict\n\nNew spec for the API.");
    writeFileSync(provSrc, JSON.stringify({ linkedMapArea: "src/api", classifiedAs: "spec-raw" }));

    const result = specPromote(src, { repoRoot, runId: "spec-run-map" });

    expect(result.halted).toBe(true);
    const mapConflict = result.conflicts.find((c) => c.type === "map");
    expect(mapConflict).toBeDefined();
  });

  it("throws if source is not in smartdocs/docs/raw/", () => {
    const src = join(repoRoot, "smartdocs", "docs", "specs", "active", "wrong.md");
    writeFileSync(src, "# Wrong");

    expect(() => specPromote(src, { repoRoot })).toThrow(
      "specPromote source must be in smartdocs/docs/raw/",
    );
  });

  it("throws if destination already exists", () => {
    const src = join(repoRoot, "smartdocs", "docs", "raw", "dupe-spec.md");
    writeFileSync(src, "# Dupe");
    writeFileSync(join(repoRoot, "smartdocs", "docs", "specs", "active", "dupe-spec.md"), "# Already there");

    expect(() => specPromote(src, { repoRoot })).toThrow("Destination already exists");
  });

  it("emits lifecycle event on successful promote", () => {
    const src = join(repoRoot, "smartdocs", "docs", "raw", "lifecycle-spec.md");
    writeFileSync(src, "# Lifecycle Spec\n\nContent here.");

    const result = specPromote(src, { repoRoot, runId: "spec-lifecycle-001" });

    expect(existsSync(result.lifecyclePath)).toBe(true);
    const event = JSON.parse(readFileSync(result.lifecyclePath, "utf-8").trim().split("\n")[0]);
    expect(event.event).toBe("spec-promote");
    expect(event.run_id).toBe("spec-lifecycle-001");
  });
});
