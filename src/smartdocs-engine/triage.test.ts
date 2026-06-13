import { describe, expect, it } from "vitest";
import { clusterCandidates, extractSymbols } from "./triage.js";

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
