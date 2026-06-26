import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import type { InterviewRecord } from "./schema.js";

export interface ValidationStatus {
  passed: boolean;
  message?: string;
}

export interface CheckpointReport {
  timestamp: string; // ISO string
  interviewStatus: string;
  createdFiles: string[];
  validationResults: Record<string, ValidationStatus>;
  nextSteps: string[];
}

export interface BuildCheckpointReportOptions {
  repoRoot: string;
  record: InterviewRecord;
  now?: Date;
}

function getGeneratedFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const candidates = [
    "GENESIS.md",
    "polaris.config.json",
    "POLARIS_RULES.md",
    "POLARIS.md",
    "SUMMARY.md",
    "CLAUDE.md",
    "AGENTS.md",
    ".github/copilot-instructions.md",
    ".polaris/map/index.json",
  ];

  for (const file of candidates) {
    if (existsSync(join(repoRoot, file))) {
      files.push(file);
    }
  }

  // Check for SmartDocs migrated files
  const smartdocsDir = join(repoRoot, "smartdocs", "raw");
  if (existsSync(smartdocsDir)) {
    try {
      const smartdocsFiles = execFileSync("find", ["smartdocs/raw", "-name", "*.md", "-type", "f"], {
        cwd: repoRoot,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      files.push(...smartdocsFiles);
    } catch {
      // find command failed, ignore
    }
  }

  return files.sort();
}

function validateGeneratedFiles(repoRoot: string, files: string[]): Record<string, ValidationStatus> {
  const results: Record<string, ValidationStatus> = {};

  for (const file of files) {
    try {
      const filePath = join(repoRoot, file);
      const content = readFileSync(filePath, "utf-8");
      
      if (content.trim().length === 0) {
        results[file] = { passed: false, message: "File is empty" };
      } else {
        results[file] = { passed: true };
      }
    } catch (error) {
      results[file] = { 
        passed: false, 
        message: error instanceof Error ? error.message : "Unknown error" 
      };
    }
  }

  return results;
}

function buildNextSteps(record: InterviewRecord): string[] {
  const steps: string[] = [];
  
  steps.push("Review generated files in your repository");
  steps.push("Run `polaris status` to verify setup");
  
  if (record.answers.canonical_doc_folders && record.answers.canonical_doc_folders.length > 0) {
    steps.push("Check migrated documentation in smartdocs/raw/");
  }
  
  steps.push("Start using Polaris: run `polaris analyze` to explore your codebase");
  
  return steps;
}

export function buildCheckpointReport(options: BuildCheckpointReportOptions): CheckpointReport {
  const { repoRoot, record, now } = options;
  const timestamp = (now ?? new Date()).toISOString();

  const createdFiles = getGeneratedFiles(repoRoot);
  const validationResults = validateGeneratedFiles(repoRoot, createdFiles);
  const nextSteps = buildNextSteps(record);

  return {
    timestamp,
    interviewStatus: record.status,
    createdFiles,
    validationResults,
    nextSteps,
  };
}

export function writeCheckpointReport(repoRoot: string, report: CheckpointReport): void {
  // Safe timestamp: replace ":" with "-" and "." with "-"
  // e.g. "2026-06-09T12:00:00.000Z" → "checkpoint-report-2026-06-09T12-00-00-000Z.json"
  const safeTimestamp = report.timestamp.replace(/:/g, "-").replace(/\./g, "-");
  const fileName = `checkpoint-report-${safeTimestamp}.json`;

  const runsDir = join(repoRoot, ".polaris", "runs");
  if (!existsSync(runsDir)) {
    mkdirSync(runsDir, { recursive: true });
  }

  const reportPath = join(runsDir, fileName);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
}

export function printCheckpointReport(report: CheckpointReport): void {
  // Print structured summary to stdout
  console.log("Setup Checkpoint Report:");
  console.log(`  Timestamp: ${report.timestamp}`);
  console.log(`  Interview Status: ${report.interviewStatus}`);
  console.log("");

  console.log("Generated Files:");
  if (report.createdFiles.length === 0) {
    console.log("  (none)");
  } else {
    for (const file of report.createdFiles) {
      const validation = report.validationResults[file];
      const status = validation.passed ? "✓" : "✗";
      console.log(`  ${status} ${file}`);
      if (validation.message) {
        console.log(`    ${validation.message}`);
      }
    }
  }
  console.log("");

  const failedValidations = Object.entries(report.validationResults).filter(
    ([_, result]) => !result.passed
  );

  if (failedValidations.length > 0) {
    console.log("Validation Failures:");
    for (const [file, result] of failedValidations) {
      console.log(`  ${file}: ${result.message}`);
    }
    console.log("");
  }

  console.log("Next Steps:");
  for (const step of report.nextSteps) {
    console.log(`  • ${step}`);
  }
  console.log("");
}