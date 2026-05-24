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
} from "./doctrine.js";

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "polaris-doctrine-"));
  mkdirSync(join(root, "docs", "raw"), { recursive: true });
  mkdirSync(join(root, "docs", "doctrine", "raw"), { recursive: true });
  mkdirSync(join(root, "docs", "doctrine", "candidate"), { recursive: true });
  mkdirSync(join(root, "docs", "doctrine", "active"), { recursive: true });
  mkdirSync(join(root, "docs", "doctrine", "deprecated"), { recursive: true });
  return root;
}

describe("doctrineDraft", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("moves a file from docs/raw/ to docs/doctrine/candidate/ with candidate marker", () => {
    const source = join(repoRoot, "docs", "raw", "some-doc.md");
    writeFileSync(source, "# Some Doc\n\nContent here.");

    const result = doctrineDraft(source, { repoRoot, runId: "test-run-001" });

    expect(result.destination).toBe(join(repoRoot, "docs", "doctrine", "candidate", "some-doc.md"));
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(source)).toBe(false);

    const content = readFileSync(result.destination, "utf-8");
    expect(content.startsWith(CANDIDATE_MARKER)).toBe(true);
    expect(content).toContain("# Some Doc");
  });

  it("moves a file from docs/doctrine/raw/ to docs/doctrine/candidate/", () => {
    const source = join(repoRoot, "docs", "doctrine", "raw", "draft-doc.md");
    writeFileSync(source, "# Draft");

    const result = doctrineDraft(source, { repoRoot, runId: "test-run-001" });

    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(source)).toBe(false);
  });

  it("emits a doctrine-draft event to lifecycle.jsonl", () => {
    const source = join(repoRoot, "docs", "raw", "event-doc.md");
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
      doctrineDraft(join(repoRoot, "docs", "raw", "nonexistent.md"), { repoRoot }),
    ).toThrow("Source file not found");
  });

  it("throws if source is not in docs/raw/ or docs/doctrine/raw/", () => {
    const source = join(repoRoot, "docs", "doctrine", "active", "wrong.md");
    writeFileSync(source, "# Wrong location");

    expect(() => doctrineDraft(source, { repoRoot })).toThrow(
      "doctrineDraft source must be in docs/raw/ or docs/doctrine/raw/",
    );
  });

  it("throws if destination already exists", () => {
    const source = join(repoRoot, "docs", "raw", "dupe.md");
    writeFileSync(source, "# Dupe");
    const dest = join(repoRoot, "docs", "doctrine", "candidate", "dupe.md");
    writeFileSync(dest, "# Already there");

    expect(() => doctrineDraft(source, { repoRoot })).toThrow("Destination already exists");
  });
});

describe("doctrinePromote", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("moves a file from candidate/ to active/ and strips the candidate marker", () => {
    const candidatePath = join(repoRoot, "docs", "doctrine", "candidate", "my-doctrine.md");
    writeFileSync(candidatePath, `${CANDIDATE_MARKER}\n# My Doctrine\n\nContent.`);

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-002" });

    expect(result.destination).toBe(
      join(repoRoot, "docs", "doctrine", "active", "my-doctrine.md"),
    );
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(candidatePath)).toBe(false);

    const content = readFileSync(result.destination, "utf-8");
    expect(content).not.toContain(CANDIDATE_MARKER);
    expect(content).toContain("# My Doctrine");
  });

  it("emits a doctrine-promote event to lifecycle.jsonl", () => {
    const candidatePath = join(repoRoot, "docs", "doctrine", "candidate", "promoted.md");
    writeFileSync(candidatePath, `${CANDIDATE_MARKER}\n# Promoted`);

    const result = doctrinePromote(candidatePath, { repoRoot, runId: "test-run-002" });

    const event = JSON.parse(readFileSync(result.lifecyclePath, "utf-8").trim().split("\n")[0]);
    expect(event.event).toBe("doctrine-promote");
    expect(event.run_id).toBe("test-run-002");
  });

  it("throws if source is not in docs/doctrine/candidate/", () => {
    const source = join(repoRoot, "docs", "raw", "wrong.md");
    writeFileSync(source, `${CANDIDATE_MARKER}\n# Wrong`);

    expect(() => doctrinePromote(source, { repoRoot })).toThrow(
      "doctrinePromote source must be in docs/doctrine/candidate/",
    );
  });

  it("throws if file is missing the candidate marker", () => {
    const source = join(repoRoot, "docs", "doctrine", "candidate", "unmarked.md");
    writeFileSync(source, "# No marker");

    expect(() => doctrinePromote(source, { repoRoot })).toThrow("not in candidate state");
  });

  it("throws if source does not exist", () => {
    expect(() =>
      doctrinePromote(
        join(repoRoot, "docs", "doctrine", "candidate", "ghost.md"),
        { repoRoot },
      ),
    ).toThrow("Source file not found");
  });
});

describe("doctrineDeprecate", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  it("moves a file from active/ to deprecated/ with deprecation provenance header", () => {
    const activePath = join(repoRoot, "docs", "doctrine", "active", "old-doctrine.md");
    writeFileSync(activePath, "# Old Doctrine\n\nOriginal content.");

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-003" });

    expect(result.destination).toBe(
      join(repoRoot, "docs", "doctrine", "deprecated", "old-doctrine.md"),
    );
    expect(existsSync(result.destination)).toBe(true);
    expect(existsSync(activePath)).toBe(false);

    const content = readFileSync(result.destination, "utf-8");
    expect(content).toContain("polaris:doctrine-deprecated");
    expect(content).toContain("# Old Doctrine");
  });

  it("emits a doctrine-deprecate event to lifecycle.jsonl", () => {
    const activePath = join(repoRoot, "docs", "doctrine", "active", "deprecated.md");
    writeFileSync(activePath, "# Deprecated");

    const result = doctrineDeprecate(activePath, { repoRoot, runId: "test-run-003" });

    const event = JSON.parse(readFileSync(result.lifecyclePath, "utf-8").trim().split("\n")[0]);
    expect(event.event).toBe("doctrine-deprecate");
    expect(event.run_id).toBe("test-run-003");
    expect(event.deprecated_at).toBeDefined();
  });

  it("throws if source is not in docs/doctrine/active/", () => {
    const source = join(repoRoot, "docs", "doctrine", "candidate", "wrong.md");
    writeFileSync(source, `${CANDIDATE_MARKER}\n# Wrong`);

    expect(() => doctrineDeprecate(source, { repoRoot })).toThrow(
      "doctrineDeprecate source must be in docs/doctrine/active/",
    );
  });

  it("throws if source does not exist", () => {
    expect(() =>
      doctrineDeprecate(
        join(repoRoot, "docs", "doctrine", "active", "ghost.md"),
        { repoRoot },
      ),
    ).toThrow("Source file not found");
  });
});
