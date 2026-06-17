import { describe, expect, it } from "vitest";
import { clusterCandidates, extractSymbols, loadDocMeta, readTriageCheckpoint, writeTriageCheckpoint, writeTriageQueue, runBatchComparison, runGraphCheck, runTriage } from "./triage.js";
import type { LlmClient, TriageOptions } from "./triage.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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

describe("checkpoint I/O", () => {
  it("returns null when no checkpoint exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-ckpt-"));
    expect(readTriageCheckpoint(dir)).toBeNull();
  });

  it("round-trips a checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-ckpt-"));
    const ckpt = { completedClusters: ["governance", "decision"], flags: [] };
    writeTriageCheckpoint(ckpt, dir);
    const loaded = readTriageCheckpoint(dir);
    expect(loaded?.completedClusters).toEqual(["governance", "decision"]);
  });
});

describe("writeTriageQueue", () => {
  it("writes _triage-queue.json and _triage-report.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-queue-"));
    const packet: import("../governance/types.js").TriageReviewPacket = {
      sourcePath: "smartdocs/doctrine/candidate/foo.md",
      proposedDestination: "smartdocs/doctrine/candidate/foo.md",
      classificationConfidence: 0,
      destinationCertainty: 0,
      authorityRisk: "low",
      reasoning: [],
      conflicts: [],
      recommendation: "defer",
      outcomeReason: "flagged by triage",
      triageFlag: "contradiction",
      relatedCanonical: "smartdocs/doctrine/active/bar.md",
    };

    writeTriageQueue([packet], dir);

    expect(existsSync(join(dir, "_triage-queue.json"))).toBe(true);
    expect(existsSync(join(dir, "_triage-report.md"))).toBe(true);

    const raw = JSON.parse(readFileSync(join(dir, "_triage-queue.json"), "utf-8"));
    expect(raw.packets).toHaveLength(1);
    expect(raw.packets[0].triageFlag).toBe("contradiction");
  });
});

describe("runBatchComparison", () => {
  const candidates: import("./triage.js").DocMeta[] = [
    {
      path: "smartdocs/doctrine/candidate/ADR-101.md",
      tags: ["governance"],
      type: "Decision",
      clusterMembership: [],
      relatedNotes: [],
      filenamePrefixes: ["ADR"],
    },
  ];

  const canonicals: import("./triage.js").DocMeta[] = [
    {
      path: "smartdocs/doctrine/active/ADR-001.md",
      tags: ["governance"],
      type: "Decision",
      clusterMembership: [],
      relatedNotes: [],
      filenamePrefixes: ["ADR"],
    },
  ];

  it("returns flags from a valid LLM response", async () => {
    const mockClient: LlmClient = {
      async compare(_c, _can, _model) {
        return [
          {
            candidatePath: "smartdocs/doctrine/candidate/ADR-101.md",
            flagType: "contradiction",
            canonicalPath: "smartdocs/doctrine/active/ADR-001.md",
            reason: "Claims opposite authority model.",
          },
        ];
      },
    };

    const flags = await runBatchComparison(candidates, canonicals, {
      model: "claude-haiku-4-5-20251001",
      llmClient: mockClient,
    });

    expect(flags).toHaveLength(1);
    expect(flags[0].flagType).toBe("contradiction");
  });

  it("returns empty array when LLM finds no issues", async () => {
    const mockClient: LlmClient = {
      async compare() { return []; },
    };

    const flags = await runBatchComparison(candidates, canonicals, {
      model: "claude-haiku-4-5-20251001",
      llmClient: mockClient,
    });

    expect(flags).toHaveLength(0);
  });

  it("retries once on invalid JSON, then returns empty array with no throw", async () => {
    let calls = 0;
    const mockClient: LlmClient = {
      async compare() {
        calls++;
        throw new Error("bad json");
      },
    };

    const flags = await runBatchComparison(candidates, canonicals, {
      model: "claude-haiku-4-5-20251001",
      llmClient: mockClient,
    });

    expect(flags).toEqual([]);
    expect(calls).toBe(2); // tried twice
  });
});

describe("runGraphCheck", () => {
  it("skips check when symbolCount < 1000", () => {
    const candidates: import("./triage.js").DocMeta[] = [
      { path: "smartdocs/doctrine/candidate/foo.md", tags: [], type: "", clusterMembership: [], relatedNotes: [], filenamePrefixes: [] },
    ];

    const flags = runGraphCheck(candidates, {
      getContent: () => "References `runTriage` and `TriageRunner` symbols.",
      symbolLookup: () => false,
      graphStats: () => ({ symbolCount: 50 }),
    });

    expect(flags).toHaveLength(0);
  });

  it("flags candidate with 2+ missing symbols", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-graph-"));
    const docPath = join(dir, "stale.md");
    writeFileSync(docPath, "Call `runTriage` then `TriageRunner` and `clusterCandidates`.", "utf-8");

    const candidates: import("./triage.js").DocMeta[] = [
      { path: docPath, tags: [], type: "", clusterMembership: [], relatedNotes: [], filenamePrefixes: [] },
    ];

    const flags = runGraphCheck(candidates, {
      getContent: (p) => readFileSync(p, "utf-8"),
      symbolLookup: () => false,
      graphStats: () => ({ symbolCount: 5000 }),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0].flagType).toBe("stale-reference");
    expect(flags[0].staleSymbols!.length).toBeGreaterThanOrEqual(2);
  });

  it("does not flag candidate with only 1 missing symbol", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-graph-"));
    const docPath = join(dir, "ok.md");
    writeFileSync(docPath, "Call `onlyMissing` and some text without symbols.", "utf-8");

    const candidates: import("./triage.js").DocMeta[] = [
      { path: docPath, tags: [], type: "", clusterMembership: [], relatedNotes: [], filenamePrefixes: [] },
    ];

    const flags = runGraphCheck(candidates, {
      getContent: (p) => readFileSync(p, "utf-8"),
      symbolLookup: () => false,
      graphStats: () => ({ symbolCount: 5000 }),
    });

    expect(flags).toHaveLength(0);
  });
});

describe("runTriage", () => {
  function makeTriageRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "triage-orch-"));
    mkdirSync(join(dir, "smartdocs", "doctrine", "active"), { recursive: true });
    mkdirSync(join(dir, "smartdocs", "doctrine", "candidate"), { recursive: true });
    mkdirSync(join(dir, "smartdocs", "raw"), { recursive: true });

    writeFileSync(
      join(dir, "smartdocs", "doctrine", "active", "ADR-001.md"),
      "---\nTags: [governance]\nType: Decision\n---\n# ADR-001\nGoverns dual metric system.",
      "utf-8",
    );

    writeFileSync(
      join(dir, "smartdocs", "doctrine", "candidate", "ADR-101.md"),
      "---\nTags: [governance]\nType: Decision\n---\n# ADR-101\nContradicts ADR-001.",
      "utf-8",
    );

    return dir;
  }

  it("writes _triage-queue.json when flags are found", async () => {
    const repoRoot = makeTriageRepo();

    const mockClient: LlmClient = {
      async compare(candidates) {
        return candidates.map((c) => ({
          candidatePath: c.path,
          flagType: "contradiction" as const,
          canonicalPath: "smartdocs/doctrine/active/ADR-001.md",
          reason: "Contradicts the canonical.",
        }));
      },
    };

    const result = await runTriage({
      repoRoot,
      batchSize: 10,
      llmClient: mockClient,
      symbolLookup: () => true,
      graphStats: () => ({ symbolCount: 5000 }),
    });

    expect(result.flagCount).toBeGreaterThan(0);
    expect(existsSync(join(repoRoot, "smartdocs", "raw", "_triage-queue.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "smartdocs", "raw", "_triage-report.md"))).toBe(true);
  });

  it("dry-run prints estimate and writes no files", async () => {
    const repoRoot = makeTriageRepo();
    const messages: string[] = [];

    await runTriage({
      repoRoot,
      dryRun: true,
      llmClient: { async compare() { return []; } },
      symbolLookup: () => true,
      graphStats: () => ({ symbolCount: 5000 }),
      output: (m) => messages.push(m),
    });

    expect(messages.some((m) => m.includes("Estimated"))).toBe(true);
    expect(existsSync(join(repoRoot, "smartdocs", "raw", "_triage-queue.json"))).toBe(false);
  });

  it("resumes from checkpoint, skipping completed clusters", async () => {
    const repoRoot = makeTriageRepo();
    const outputDir = join(repoRoot, "smartdocs", "raw");

    writeTriageCheckpoint({ completedClusters: ["governance", "decision", "general"], flags: [] }, outputDir);

    let compareCalls = 0;
    const mockClient: LlmClient = {
      async compare() { compareCalls++; return []; },
    };

    await runTriage({
      repoRoot,
      llmClient: mockClient,
      symbolLookup: () => true,
      graphStats: () => ({ symbolCount: 5000 }),
    });

    expect(compareCalls).toBe(0);
  });
});
