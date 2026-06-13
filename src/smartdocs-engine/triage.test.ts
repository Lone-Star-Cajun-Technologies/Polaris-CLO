import { describe, expect, it } from "vitest";
import { clusterCandidates, extractSymbols, loadDocMeta } from "./triage.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("clusterCandidates", () => {
  it("groups candidates by shared tag with canonicals", () => {
    const candidates = [
      {
        path: "smartdocs/doctrine/candidate/ADR-101.md",
        tags: ["governance"],
        type: "Decision",
        clusterMembership: [],
        relatedNotes: [],
        filenamePrefixes: ["ADR"],
      },
      {
        path: "smartdocs/doctrine/candidate/random-note.md",
        tags: [],
        type: "Note",
        clusterMembership: [],
        relatedNotes: [],
        filenamePrefixes: [],
      },
    ];

    const canonicals = [
      {
        path: "smartdocs/doctrine/active/ADR-001.md",
        tags: ["governance"],
        type: "Decision",
        clusterMembership: [],
        relatedNotes: [],
        filenamePrefixes: ["ADR"],
      },
    ];

    const result = clusterCandidates(candidates, canonicals);

    // ADR-101 matches the "governance" / "ADR" cluster
    expect(result["governance"]).toBeDefined();
    expect(result["governance"].candidates).toHaveLength(1);
    expect(result["governance"].candidates[0].path).toBe("smartdocs/doctrine/candidate/ADR-101.md");
    expect(result["governance"].canonicals).toHaveLength(1);

    // random-note goes to general
    expect(result["general"]).toBeDefined();
    expect(result["general"].candidates[0].path).toBe("smartdocs/doctrine/candidate/random-note.md");
  });

  it("puts all candidates in general when no canonicals match", () => {
    const candidates = [
      {
        path: "smartdocs/doctrine/candidate/orphan.md",
        tags: ["unknown"],
        type: "Note",
        clusterMembership: [],
        relatedNotes: [],
        filenamePrefixes: [],
      },
    ];

    const result = clusterCandidates(candidates, []);
    expect(result["general"].candidates).toHaveLength(1);
  });
});

describe("extractSymbols", () => {
  it("extracts backtick tokens", () => {
    const syms = extractSymbols("Call `runTriage` then `writeCheckpoint` to proceed.");
    expect(syms).toContain("runTriage");
    expect(syms).toContain("writeCheckpoint");
  });

  it("extracts PascalCase and camelCase identifiers", () => {
    const syms = extractSymbols("The TriageRunner calls clusterCandidates before batching.");
    expect(syms).toContain("TriageRunner");
    expect(syms).toContain("clusterCandidates");
  });

  it("skips short words and plain prose", () => {
    const syms = extractSymbols("The doc is good. This runs fast.");
    expect(syms).not.toContain("The");
    expect(syms).not.toContain("This");
    expect(syms).not.toContain("good");
  });

  it("deduplicates symbols", () => {
    const syms = extractSymbols("`runTriage` and `runTriage` again.");
    expect(syms.filter((s) => s === "runTriage")).toHaveLength(1);
  });
});

describe("loadDocMeta", () => {
  it("parses tags, type, and cluster from YAML frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
    const docPath = join(dir, "test.md");
    writeFileSync(docPath, [
      "---",
      "Tags: [governance, learning]",
      "Type: Decision",
      "Member Of Concept Cluster: [EVOlearn]",
      "Related Notes:",
      '  - "[[ADR-002|ADR-002]]"',
      "---",
      "# Body text",
    ].join("\n"), "utf-8");

    const meta = loadDocMeta(docPath);
    expect(meta.tags).toContain("governance");
    expect(meta.tags).toContain("learning");
    expect(meta.type).toBe("Decision");
    expect(meta.clusterMembership).toContain("EVOlearn");
    expect(meta.filenamePrefixes).toContain("test");
    expect(meta.relatedNotes).toContain("ADR-002");
  });

  it("returns empty arrays for docs with no frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
    const docPath = join(dir, "plain.md");
    writeFileSync(docPath, "# Just a heading\n\nSome text.", "utf-8");

    const meta = loadDocMeta(docPath);
    expect(meta.tags).toEqual([]);
    expect(meta.type).toBe("");
    expect(meta.clusterMembership).toEqual([]);
  });
});
