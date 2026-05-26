import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import type { LoopState } from "./checkpoint.js";
import {
  buildCompactBootstrapState,
  buildExecutionAdapterContract,
  selectExecutionAdapter,
  type ExecutionAdapterContract,
  type ExecutionAdapterMode,
} from "./execution-adapter.js";
import type { PolarisConfig } from "../config/schema.js";

type PacketExecutionConfig = Required<PolarisConfig>["execution"] & {
  allow_analyze_children?: boolean;
};

type CompactConfig = Required<PolarisConfig>["compact"];

export interface BootstrapPacket {
  run_id: string;
  skill: string;
  branch: string;
  base_commit_sha: string;
  last_completed_step: string | null;
  last_completed_child: string;
  next_step: string;
  open_children: string[];
  artifact_pointers: {
    current_state: string;
    telemetry: string;
  };
  context_budget: {
    children_completed: number;
    files_touched_total: number;
    stop_threshold_remaining: number;
  };
  current_state_sha: string;
  resume_instructions: string;
  compact_mode?: "standard" | "strict" | "minimal";
  execution_adapter?: ExecutionAdapterContract;
  boundary_enforcement?: string;
}

function getCurrentBranch(repoRoot: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function getHeadSha(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

export function buildBootstrapPacket(
  state: LoopState,
  stateFile: string,
  currentStateSha: string,
  repoRoot: string,
  completedChild: string,
  adapterMode?: ExecutionAdapterMode,
  executionConfig?: PacketExecutionConfig,
  compactConfig?: CompactConfig,
): BootstrapPacket {
  const branch = getCurrentBranch(repoRoot);
  const nextChild = state.open_children[0] ?? null;
  const maxChildren = state.context_budget.max_children_per_session ?? 3;
  const filesTouched = state.context_budget.files_touched_total ?? 0;
  const stopThresholdRemaining = maxChildren - state.context_budget.children_completed;
  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "bootstrap-run");
  const telemetryFile = join(artifactDir, "runs", state.run_id, "telemetry.jsonl");

  // Resolve compact_mode: explicit level wins, then orchestratorMode, then default "standard"
  const compactMode: "standard" | "strict" | "minimal" =
    compactConfig?.level ?? compactConfig?.orchestratorMode ?? "standard";

  const resumeInstructions = nextChild
    ? `Run \`polaris loop resume ${state.run_id}\` on branch \`${branch}\` to continue with ${nextChild}.`
    : `All children complete. Run \`polaris loop status\` to verify cluster state.`;
  const adapterSelection = selectExecutionAdapter({
    configuredAdapter: adapterMode,
    insideAgentSession: process.env.POLARIS_AGENT_SESSION === "1",
    nativeSubtaskAvailable: process.env.POLARIS_NATIVE_SUBTASK === "1",
    crossAgentConfigured:
      executionConfig?.allowCrossAgentFallback === true ||
      process.env.POLARIS_ALLOW_CROSS_AGENT === "1",
    tokenBudgetLow: process.env.POLARIS_TOKEN_BUDGET_LOW === "1",
  });
  const compactBootstrapState = buildCompactBootstrapState({
    runId: state.run_id,
    clusterId: state.cluster_id,
    childId: nextChild,
    stateFile,
    telemetryFile,
    currentStateSha,
    branch,
    allowAnalyzeChildren: executionConfig?.allow_analyze_children,
    compactMode,
  });

  // Normalize artifact_pointers to repo-relative paths
  const relStateFile = stateFile.startsWith("/") ? relative(repoRoot, stateFile) : stateFile;
  const relTelemetryFile = telemetryFile.startsWith("/") ? relative(repoRoot, telemetryFile) : telemetryFile;

  return {
    run_id: state.run_id,
    skill: state.skill ?? "bootstrap-run",
    branch,
    base_commit_sha: getHeadSha(repoRoot),
    last_completed_step: state.step_cursor,
    last_completed_child: completedChild,
    next_step: nextChild ? "03-execute-child" : "CLUSTER-COMPLETE",
    open_children: state.open_children,
    artifact_pointers: {
      current_state: relStateFile,
      telemetry: relTelemetryFile,
    },
    context_budget: {
      children_completed: state.context_budget.children_completed,
      files_touched_total: filesTouched,
      stop_threshold_remaining: stopThresholdRemaining,
    },
    current_state_sha: currentStateSha,
    resume_instructions: resumeInstructions,
    compact_mode: compactMode,
    execution_adapter: buildExecutionAdapterContract(adapterSelection, compactBootstrapState),
  };
}

export function writeBootstrapPacket(
  packet: BootstrapPacket,
  bootstrapDir: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${packet.run_id}-${timestamp}.json`;
  const outPath = join(bootstrapDir, filename);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(packet, null, 2), "utf-8");
  return outPath;
}
