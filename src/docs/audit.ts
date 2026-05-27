import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, relative, resolve } from "node:path";
import { isIngestIneligible } from "./smartdoc-ignore.js";
import { classifyDoc } from "./ingest.js";

export interface AuditFinding {
  filePath: string;
  risk: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  pipelineStage: "ingest" | "migrate" | "classify" | "promote";
  currentProtection: string | null;
  proposedEnforcementPoint: string;
}

export interface AuditResult {
  scanDate: string;
  repoRoot: string;
  findings: AuditFinding[];
  summary: {
    high: number;
    medium: number;
    low: number;
    protectedBySmartdocIgnore: number;
    alreadyProtected: number;
  };
}

const GENERATED_BASENAME_RE = /(?:summary|index|moc|overview)(?:[._-]|$)/i;
const GENERATED_SUFFIX_RE = /(?:-summary|-index)\.md$/i;

function isGeneratedBasename(filePath: string): boolean {
  const base = basename(filePath);
  return GENERATED_BASENAME_RE.test(base) || GENERATED_SUFFIX_RE.test(base);
}

export function auditIngestRiskSurface(repoRoot: string): AuditResult {
  const absRoot = resolve(repoRoot);

  let rawOutput: string;
  try {
    rawOutput = execFileSync("git", ["ls-files", "--", "*.md"], {
      cwd: absRoot,
      encoding: "utf-8",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list tracked markdown files via git: ${message}`);
  }

  const trackedFiles = rawOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const findings: AuditFinding[] = [];

  for (const relPath of trackedFiles) {
    const absPath = resolve(absRoot, relPath);
    const eligibility = isIngestIneligible(relPath, absRoot);

    // MEDIUM: file is in Polaris-Docs/ canonical output dirs
    // Check this BEFORE the ineligible branch so these findings are always emitted
    if (relPath.startsWith("Polaris-Docs/")) {
      const protection = eligibility.ineligible
        ? "isIngestIneligible"
        : null;
      findings.push({
        filePath: relPath,
        risk: "MEDIUM",
        reason:
          "File in Polaris-Docs/ canonical output — migrateDocs() would attempt to move it back",
        pipelineStage: "migrate",
        currentProtection: protection,
        proposedEnforcementPoint: "endpoint artifact protection in migrateDocs()",
      });
      // Don't continue yet - still need to check ineligible for HIGH findings
    }

    if (eligibility.ineligible) {
      // HIGH: endpoint artifact that could be ingested
      findings.push({
        filePath: relPath,
        risk: "HIGH",
        reason:
          "Endpoint artifact matched by .smartdocignore default patterns — ingest would be blocked but file is tracked",
        pipelineStage: "ingest",
        currentProtection: "isIngestIneligible",
        proposedEnforcementPoint: "smartdoc-ignore check in ingestDocs()",
      });

      // HIGH (second case): endpoint artifact that would classify as doctrine-candidate
      if (existsSync(absPath)) {
        let content: string;
        try {
          content = readFileSync(absPath, "utf-8");
        } catch {
          content = "";
        }
        const classification = classifyDoc(content, relPath);
        if (classification === "doctrine-candidate") {
          findings.push({
            filePath: relPath,
            risk: "HIGH",
            reason:
              "Endpoint artifact would be classified as doctrine-candidate — if bypass were used, it would enter doctrine pipeline",
            pipelineStage: "classify",
            currentProtection: "isIngestIneligible",
            proposedEnforcementPoint: "endpoint artifact check before classifyDoc()",
          });
        }
      }

      continue;
    }

    // MEDIUM: generated summary/index/MOC/overview basename
    if (isGeneratedBasename(relPath)) {
      const protection = isIngestIneligible(relPath, absRoot).ineligible
        ? "isIngestIneligible"
        : null;
      findings.push({
        filePath: relPath,
        risk: "MEDIUM",
        reason: "Generated summary or index file — ingest risk if not protected",
        pipelineStage: "ingest",
        currentProtection: protection,
        proposedEnforcementPoint: "smartdoc-ignore pattern or explicit check",
      });
    }
  }

  const high = findings.filter((f) => f.risk === "HIGH").length;
  const medium = findings.filter((f) => f.risk === "MEDIUM").length;
  const low = findings.filter((f) => f.risk === "LOW").length;
  const protectedBySmartdocIgnore = findings.filter(
    (f) => f.currentProtection === "isIngestIneligible",
  ).length;

  return {
    scanDate: new Date().toISOString(),
    repoRoot: absRoot,
    findings,
    summary: {
      high,
      medium,
      low,
      protectedBySmartdocIgnore,
      alreadyProtected: protectedBySmartdocIgnore,
    },
  };
}

export function formatAuditMarkdown(result: AuditResult): string {
  const lines: string[] = [
    "# Polaris Smart Docs — Ingest Risk Audit",
    "",
    `**Scanned:** ${result.repoRoot}`,
    `**Date:** ${result.scanDate}`,
    "",
    `## Summary`,
    "",
    `| Risk | Count |`,
    `|------|-------|`,
    `| HIGH | ${result.summary.high} |`,
    `| MEDIUM | ${result.summary.medium} |`,
    `| LOW | ${result.summary.low} |`,
    `| Protected by .smartdocignore | ${result.summary.protectedBySmartdocIgnore} |`,
    "",
  ];

  const highFindings = result.findings.filter((f) => f.risk === "HIGH");
  const mediumFindings = result.findings.filter((f) => f.risk === "MEDIUM");
  const lowFindings = result.findings.filter((f) => f.risk === "LOW");

  if (highFindings.length > 0) {
    lines.push("## HIGH Risk Findings", "");
    for (const f of highFindings) {
      lines.push(
        `### \`${f.filePath}\``,
        "",
        `- **Reason:** ${f.reason}`,
        `- **Pipeline stage:** ${f.pipelineStage}`,
        `- **Current protection:** ${f.currentProtection ?? "none"}`,
        `- **Proposed enforcement:** ${f.proposedEnforcementPoint}`,
        "",
      );
    }
  }

  if (mediumFindings.length > 0) {
    lines.push("## MEDIUM Risk Findings", "");
    for (const f of mediumFindings) {
      lines.push(
        `### \`${f.filePath}\``,
        "",
        `- **Reason:** ${f.reason}`,
        `- **Pipeline stage:** ${f.pipelineStage}`,
        `- **Current protection:** ${f.currentProtection ?? "none"}`,
        `- **Proposed enforcement:** ${f.proposedEnforcementPoint}`,
        "",
      );
    }
  }

  if (lowFindings.length > 0) {
    lines.push("## LOW Risk Findings", "");
    for (const f of lowFindings) {
      lines.push(
        `### \`${f.filePath}\``,
        "",
        `- **Reason:** ${f.reason}`,
        `- **Pipeline stage:** ${f.pipelineStage}`,
        `- **Current protection:** ${f.currentProtection ?? "none"}`,
        `- **Proposed enforcement:** ${f.proposedEnforcementPoint}`,
        "",
      );
    }
  }

  if (result.findings.length === 0) {
    lines.push("_No findings — no files at risk of recursive ingestion detected._", "");
  }

  return lines.join("\n");
}

export function formatAuditSummaryTable(result: AuditResult): string {
  const lines: string[] = [
    "Polaris Smart Docs — Ingest Risk Audit",
    `Scanned: ${result.repoRoot}  Date: ${result.scanDate}`,
    "",
  ];

  const highFindings = result.findings.filter((f) => f.risk === "HIGH");
  const mediumFindings = result.findings.filter((f) => f.risk === "MEDIUM");
  const lowFindings = result.findings.filter((f) => f.risk === "LOW");

  if (highFindings.length > 0) {
    lines.push(`HIGH (${highFindings.length}):`);
    for (const f of highFindings) {
      lines.push(`  ${f.filePath} — ${f.reason} [stage: ${f.pipelineStage}]`);
    }
    lines.push("");
  }

  if (mediumFindings.length > 0) {
    lines.push(`MEDIUM (${mediumFindings.length}):`);
    for (const f of mediumFindings) {
      lines.push(`  ${f.filePath} — ${f.reason} [stage: ${f.pipelineStage}]`);
    }
    lines.push("");
  }

  if (lowFindings.length > 0) {
    lines.push(`LOW (${lowFindings.length}):`);
    for (const f of lowFindings) {
      lines.push(`  ${f.filePath} — ${f.reason} [stage: ${f.pipelineStage}]`);
    }
    lines.push("");
  }

  lines.push(
    "Summary:",
    `  High: ${result.summary.high}  Medium: ${result.summary.medium}  Low: ${result.summary.low}`,
    `  Protected by .smartdocignore: ${result.summary.protectedBySmartdocIgnore}`,
  );

  return lines.join("\n");
}
