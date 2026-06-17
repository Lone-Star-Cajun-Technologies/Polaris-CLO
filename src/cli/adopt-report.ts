import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import type {
  WorkspaceInstallResult,
  GraphBuildResult,
  GraphBuildStatus,
} from "./adopt-assets.js";
import type { AgentReconcileRecord } from "./adopt-genesis.js";
import type { InstructionActionRecord } from "./adopt-instructions.js";

export type { InstructionActionRecord };

export interface AdoptionReport {
  timestamp: string; // ISO string
  installed: string[];
  alreadyPresent: string[];
  skipped: string[];
  conflicted: string[];
  graphStatus: GraphBuildStatus;
  graphDetail?: string; // stdout on success, reason on failure
  graphFollowUp?: string; // follow-up command on failure/skip
  agents: AgentReconcileRecord[];
  instructionMigration: InstructionActionRecord[]; // instruction file migration outcomes
}

export interface BuildAdoptionReportOptions {
  install: WorkspaceInstallResult;
  graph: GraphBuildResult;
  agents: AgentReconcileRecord[];
  instructionMigration?: InstructionActionRecord[];
  now?: Date;
}

export function buildAdoptionReport(options: BuildAdoptionReportOptions): AdoptionReport {
  const { install, graph, agents, instructionMigration, now } = options;
  const timestamp = (now ?? new Date()).toISOString();

  return {
    timestamp,
    installed: install.installed,
    alreadyPresent: install.alreadyPresent,
    skipped: install.skipped,
    conflicted: install.conflicted,
    graphStatus: graph.status,
    graphDetail: graph.stdout ?? graph.reason,
    graphFollowUp: graph.followUpCommand,
    agents,
    instructionMigration: instructionMigration ?? [],
  };
}

export function writeAdoptionReport(repoRoot: string, report: AdoptionReport): void {
  // Safe timestamp: replace ":" with "-" and "." with "-"
  // e.g. "2026-06-09T12:00:00.000Z" → "adoption-report-2026-06-09T12-00-00-000Z.json"
  const safeTimestamp = report.timestamp.replace(/:/g, "-").replace(/\./g, "-");
  const fileName = `adoption-report-${safeTimestamp}.json`;

  const runsDir = join(repoRoot, ".polaris", "runs");
  if (!existsSync(runsDir)) {
    mkdirSync(runsDir, { recursive: true });
  }

  const reportPath = join(runsDir, fileName);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
}

export function printAdoptionReport(report: AdoptionReport): void {
  // Print structured summary to stdout
  console.log("Adoption Report:");
  console.log(`  Timestamp: ${report.timestamp}`);
  console.log("");

  console.log("Asset Installation:");
  console.log(`  Installed: ${report.installed.length}`);
  console.log(`  Already Present: ${report.alreadyPresent.length}`);
  console.log(`  Skipped: ${report.skipped.length}`);
  console.log(`  Conflicted: ${report.conflicted.length}`);
  console.log("");

  console.log("Agent Files:");
  if (report.agents.length === 0) {
    console.log("  (none)");
  } else {
    for (const agent of report.agents) {
      console.log(`  ${agent.file}: ${agent.outcome}`);
      if (agent.genesisPath) {
        console.log(`    -> archived to ${agent.genesisPath}`);
      }
    }
  }
  console.log("");

  console.log("Instruction Migration:");
  if (report.instructionMigration.length === 0) {
    console.log("  (none)");
  } else {
    for (const record of report.instructionMigration) {
      console.log(`  ${record.source_path}: ${record.decision}`);
      if (record.backup_path) {
        console.log(`    -> archived to ${record.backup_path}`);
      }
    }
  }
  console.log("");

  console.log("Graph Build:");
  console.log(`  Status: ${report.graphStatus}`);
  if (report.graphDetail) {
    console.log(`  Detail: ${report.graphDetail}`);
  }
  if (report.graphFollowUp) {
    console.log(`  Follow-up: ${report.graphFollowUp}`);
  }
}
