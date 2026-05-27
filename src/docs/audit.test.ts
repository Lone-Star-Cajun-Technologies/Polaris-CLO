import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { auditIngestRiskSurface, formatAuditMarkdown, type AuditResult } from "./audit.js";

function makeGitRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "polaris-audit-"));
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  return repoRoot;
}

function addTrackedFile(repoRoot: string, relPath: string, content = "# Doc\n\nContent"): void {
  const dir = relPath.includes("/")
    ? join(repoRoot, relPath.split("/").slice(0, -1).join("/"))
    : repoRoot;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repoRoot, relPath), content, "utf-8");
  execFileSync("git", ["add", relPath], { cwd: repoRoot });
}

describe("auditIngestRiskSurface", () => {
  it("flags endpoint artifacts as HIGH risk", () => {
    const repoRoot = makeGitRepo();
    addTrackedFile(repoRoot, ".claude/SKILL.md", "# Skill doc\n");

    const result = auditIngestRiskSurface(repoRoot);

    const highIngest = result.findings.filter(
      (f) => f.risk === "HIGH" && f.pipelineStage === "ingest" && f.filePath === ".claude/SKILL.md",
    );
    expect(highIngest.length).toBe(1);
    expect(highIngest[0].currentProtection).toBe("isIngestIneligible");
    expect(result.summary.high).toBeGreaterThanOrEqual(1);
    expect(result.summary.protectedBySmartdocIgnore).toBeGreaterThanOrEqual(1);
  });

  it("flags doctrine-candidate endpoint artifacts as HIGH with pipelineStage classify", () => {
    const repoRoot = makeGitRepo();
    // Content that classifyDoc will return "doctrine-candidate" for
    const doctrineContent = "# Doctrine Rule\n\nYou must always check eligibility. Never silently fail.\n";
    addTrackedFile(repoRoot, ".claude/POLARIS-doctrine.md", doctrineContent);

    const result = auditIngestRiskSurface(repoRoot);

    const classifyFindings = result.findings.filter(
      (f) =>
        f.risk === "HIGH" &&
        f.pipelineStage === "classify" &&
        f.filePath === ".claude/POLARIS-doctrine.md",
    );
    expect(classifyFindings.length).toBe(1);
    expect(classifyFindings[0].currentProtection).toBe("isIngestIneligible");
    expect(classifyFindings[0].proposedEnforcementPoint).toContain("classifyDoc");
  });

  it("returns valid AuditResult shape with no tracked files", () => {
    const repoRoot = makeGitRepo();

    const result = auditIngestRiskSurface(repoRoot);

    expect(result).toHaveProperty("scanDate");
    expect(result).toHaveProperty("repoRoot");
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("summary");
    expect(Array.isArray(result.findings)).toBe(true);
    expect(typeof result.summary.high).toBe("number");
    expect(typeof result.summary.medium).toBe("number");
    expect(typeof result.summary.low).toBe("number");
    expect(typeof result.summary.protectedBySmartdocIgnore).toBe("number");
    expect(typeof result.summary.alreadyProtected).toBe("number");
    expect(result.summary.alreadyProtected).toBe(result.summary.protectedBySmartdocIgnore);
  });

  it("flags generated summary files as MEDIUM risk", () => {
    const repoRoot = makeGitRepo();
    addTrackedFile(repoRoot, "docs/sprint-summary.md", "# Sprint summary\n");

    const result = auditIngestRiskSurface(repoRoot);

    const mediumFindings = result.findings.filter(
      (f) => f.risk === "MEDIUM" && f.filePath === "docs/sprint-summary.md",
    );
    expect(mediumFindings.length).toBe(1);
    expect(mediumFindings[0].pipelineStage).toBe("ingest");
  });
});

describe("formatAuditMarkdown", () => {
  it("produces markdown with summary table and findings sections", () => {
    const result: AuditResult = {
      scanDate: "2026-05-26T00:00:00.000Z",
      repoRoot: "/repo",
      findings: [
        {
          filePath: ".claude/SKILL.md",
          risk: "HIGH",
          reason:
            "Endpoint artifact matched by .smartdocignore default patterns — ingest would be blocked but file is tracked",
          pipelineStage: "ingest",
          currentProtection: "isIngestIneligible",
          proposedEnforcementPoint: "smartdoc-ignore check in ingestDocs()",
        },
        {
          filePath: "docs/overview.md",
          risk: "MEDIUM",
          reason: "Generated summary or index file — ingest risk if not protected",
          pipelineStage: "ingest",
          currentProtection: null,
          proposedEnforcementPoint: "smartdoc-ignore pattern or explicit check",
        },
      ],
      summary: {
        high: 1,
        medium: 1,
        low: 0,
        protectedBySmartdocIgnore: 1,
        alreadyProtected: 1,
      },
    };

    const md = formatAuditMarkdown(result);

    expect(md).toContain("# Polaris Smart Docs — Ingest Risk Audit");
    expect(md).toContain("HIGH | 1");
    expect(md).toContain("MEDIUM | 1");
    expect(md).toContain(".claude/SKILL.md");
    expect(md).toContain("docs/overview.md");
    expect(md).toContain("## HIGH Risk Findings");
    expect(md).toContain("## MEDIUM Risk Findings");
  });

  it("outputs no-findings message when findings is empty", () => {
    const result: AuditResult = {
      scanDate: "2026-05-26T00:00:00.000Z",
      repoRoot: "/repo",
      findings: [],
      summary: { high: 0, medium: 0, low: 0, protectedBySmartdocIgnore: 0, alreadyProtected: 0 },
    };

    const md = formatAuditMarkdown(result);

    expect(md).toContain("No findings");
  });
});
