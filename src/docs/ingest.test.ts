import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { classifyDoc, ingestDocs } from "./ingest.js";

function makeRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "polaris-docs-ingest-"));
  mkdirSync(join(repoRoot, "docs", "raw"), { recursive: true });
  mkdirSync(join(repoRoot, ".polaris", "map"), { recursive: true });
  mkdirSync(join(repoRoot, ".taskchain_artifacts", "polaris-run"), { recursive: true });
  writeFileSync(
    join(repoRoot, "polaris.config.json"),
    JSON.stringify({ repo: { sidecarOutputPath: ".polaris/map" } }),
    "utf-8",
  );
  writeFileSync(
    join(repoRoot, ".polaris", "map", "file-routes.json"),
    JSON.stringify({
      "src/docs/index.ts": {
        domain: "docs",
        route: "src/docs",
        taskchain: "polaris-docs",
        confidence: 0.95,
        classification: "indexed",
        last_updated: "",
        updated_by: "",
        tags: ["docs"],
        instructionFile: "src/docs/POLARIS.md",
      },
    }),
    "utf-8",
  );
  writeFileSync(join(repoRoot, ".polaris", "map", "needs-review.json"), "{}\n", "utf-8");
  writeFileSync(
    join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json"),
    JSON.stringify({ run_id: "test-run-001", cluster_id: "POL-42" }),
    "utf-8",
  );
  return repoRoot;
}

describe("classifyDoc", () => {
  it("classifies docs from explicit content signals", () => {
    expect(classifyDoc("# Runtime Summary\n\nSession summary")).toBe("runtime-summary");
    expect(classifyDoc("# Audit Finding\n\nSecurity audit result")).toBe("audit-finding");
    expect(classifyDoc("# Doctrine\n\nAgents must always preserve state")).toBe("doctrine-candidate");
    expect(classifyDoc("# Feature Spec\n\nAcceptance Criteria")).toBe("spec-raw");
  });
});

describe("ingestDocs", () => {
  it("moves a raw spec, writes provenance, links map area, and emits telemetry", () => {
    const repoRoot = makeRepo();
    writeFileSync(
      join(repoRoot, "docs", "raw", "ingest-plan.md"),
      "# Ingest Spec\n\nAcceptance Criteria\n\nTouches src/docs/index.ts.",
      "utf-8",
    );

    const [result] = ingestDocs(["docs/raw/ingest-plan.md"], { repoRoot });

    expect(result.classification).toBe("spec-raw");
    expect(result.destinationPath).toBe("docs/specs/raw/ingest-plan.md");
    expect(result.linkedMapArea).toBe("src/docs");
    expect(existsSync(join(repoRoot, "docs", "specs", "raw", "ingest-plan.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "docs", "specs", "raw", "ingest-plan.provenance.json"))).toBe(true);
    const telemetry = readFileSync(
      join(repoRoot, ".taskchain_artifacts", "polaris-run", "runs", "test-run-001", "telemetry.jsonl"),
      "utf-8",
    );
    expect(telemetry).toContain("\"event\":\"docs-ingest\"");
  });

  it("rejects batches above the bounded file limit", () => {
    const repoRoot = makeRepo();
    for (const name of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
      writeFileSync(join(repoRoot, "docs", "raw", name), "# Spec\n\nAcceptance Criteria", "utf-8");
    }

    expect(() =>
      ingestDocs(
        [
          "docs/raw/a.md",
          "docs/raw/b.md",
          "docs/raw/c.md",
          "docs/raw/d.md",
          "docs/raw/e.md",
        ],
        { repoRoot },
      ),
    ).toThrow("batch limit is 4 files");
  });

  it("does not promote high-authority architecture docs without approval", () => {
    const repoRoot = makeRepo();
    writeFileSync(join(repoRoot, "docs", "raw", "architecture.md"), "# Architecture\n\nStructural design", "utf-8");

    expect(() => ingestDocs(["docs/raw/architecture.md"], { repoRoot })).toThrow("requires explicit approval");
  });
});
