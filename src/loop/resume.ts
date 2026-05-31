import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { readState, writeStateAtomic, type LoopState } from "./checkpoint.js";
import type { BootstrapPacket } from "./bootstrap-packet.js";
import { readClusterStateSync } from "../cluster-state/store.js";
import type { ChildLifecycleStatus, ClusterState } from "../cluster-state/types.js";
import {
  DEFAULT_LEDGER_PATH,
  LedgerWriter,
  type LedgerRunType,
  type RunResumedEvent,
} from "./ledger.js";

function readPacket(bootstrapDir: string, runId?: string): BootstrapPacket {
  let entries: string[];
  try {
    entries = readdirSync(bootstrapDir).filter((f) => f.endsWith(".json"));
  } catch {
    throw new Error(`Cannot read bootstrap directory: ${bootstrapDir}`);
  }

  if (entries.length === 0) {
    throw new Error(`No bootstrap packets found in ${bootstrapDir}`);
  }

  let target: string;
  if (runId) {
    const matches = entries.filter((f) => f.startsWith(`${runId}-`)).sort();
    if (matches.length === 0) {
      throw new Error(`No bootstrap packet found for run_id "${runId}" in ${bootstrapDir}`);
    }
    target = matches.at(-1)!;
  } else {
    // Pick the most recently written packet (last alphabetically by timestamp suffix)
    target = entries.sort().at(-1)!;
  }

  const raw = readFileSync(join(bootstrapDir, target), "utf-8");
  return JSON.parse(raw) as BootstrapPacket;
}

function verifyBranch(branch: string, repoRoot: string): void {
  try {
    execFileSync("git", ["rev-parse", "--verify", branch], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`branch not found: ${branch}`);
  }
}

function computeStateSha(stateFile: string): string {
  const content = readFileSync(stateFile, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

const COMPLETED_CHILD_STATUSES = new Set<ChildLifecycleStatus>(["done", "finalized"]);
const OPEN_CHILD_STATUSES = new Set<ChildLifecycleStatus>([
  "ready",
  "claimed",
  "dispatched",
  "running",
  "blocked",
  "reviewed",
]);

interface ResolvedResumeState {
  packet: BootstrapPacket;
  state: LoopState;
  stateFile: string;
}

function findClusterStateForPacket(
  repoRoot: string,
  packet: BootstrapPacket,
): ClusterState {
  const clustersDir = resolve(repoRoot, ".polaris", "clusters");
  const hints = new Set(
    [packet.last_completed_child, ...packet.open_children].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );

  let entries: string[];
  try {
    entries = readdirSync(clustersDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    throw new Error(
      `cannot reconstruct state: no cluster-state.json found under ${clustersDir}`,
    );
  }

  const matches = entries
    .map((clusterId) => ({
      state: readClusterStateSync(clusterId, repoRoot),
      score: 0,
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        state: ClusterState;
        score: number;
      } => candidate.state !== null,
    )
    .map((candidate) => ({
      ...candidate,
      score: candidate.state.child_states.filter((child) => hints.has(child.id)).length,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  if (matches.length === 0) {
    throw new Error(
      "cannot reconstruct state: no cluster-state.json matches the bootstrap packet children",
    );
  }

  if (matches.length > 1 && matches[0]!.score === matches[1]!.score) {
    throw new Error(
      "cannot reconstruct state: multiple cluster-state.json files match the bootstrap packet children",
    );
  }

  return matches[0]!.state;
}

function rebuildLoopStateFromClusterState(
  packet: BootstrapPacket,
  clusterState: ClusterState,
  repoRoot: string,
): LoopState {
  const clusterChildren = new Set(clusterState.child_states.map((child) => child.id));
  const completedChildren = clusterState.child_states
    .filter((child) => COMPLETED_CHILD_STATUSES.has(child.status))
    .map((child) => child.id);
  const openChildren = packet.open_children.filter((childId) => clusterChildren.has(childId));
  const fallbackOpenChildren =
    openChildren.length > 0
      ? openChildren
      : clusterState.child_states
          .filter((child) => OPEN_CHILD_STATUSES.has(child.status))
          .map((child) => child.id);
  const activeChild =
    fallbackOpenChildren.find((childId) => {
      const status = clusterState.child_states.find((child) => child.id === childId)?.status;
      return status === "claimed" || status === "dispatched" || status === "running";
    }) ??
    fallbackOpenChildren[0] ??
    packet.last_completed_child;
  const lastCommit =
    clusterState.commits[packet.last_completed_child] ??
    Object.values(clusterState.commits).at(-1);

  return {
    schema_version: "1.0",
    run_id: packet.run_id,
    cluster_id: clusterState.cluster_id,
    branch: packet.branch,
    session_type: "implement",
    active_child: activeChild,
    completed_children: completedChildren,
    open_children: fallbackOpenChildren,
    step_cursor: packet.last_completed_step,
    context_budget: {
      children_completed: packet.context_budget.children_completed,
    },
    status: "running",
    last_commit: lastCommit,
    next_open_child: fallbackOpenChildren[0] ?? null,
    artifact_dir: resolve(repoRoot, ".taskchain_artifacts", "polaris-run"),
  };
}

function resolveResumeState(
  repoRoot: string,
  packet: BootstrapPacket,
  stateFile: string,
): ResolvedResumeState {
  if (existsSync(stateFile)) {
    return {
      packet,
      state: readState(stateFile),
      stateFile,
    };
  }

  const clusterState = findClusterStateForPacket(repoRoot, packet);
  const rebuiltState = rebuildLoopStateFromClusterState(packet, clusterState, repoRoot);
  const rebuiltSha = writeStateAtomic(stateFile, rebuiltState);
  const emittedPacket: BootstrapPacket = {
    ...packet,
    artifact_pointers: {
      ...packet.artifact_pointers,
      current_state: relative(repoRoot, stateFile),
    },
    current_state_sha: rebuiltSha,
  };

  return {
    packet: emittedPacket,
    state: rebuiltState,
    stateFile,
  };
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

function normalizeRunType(sessionType: string | undefined): LedgerRunType {
  return sessionType === "analyze" ? "analyze" : "implement";
}

function ledgerLastCommit(state: Partial<LoopState>): string | null {
  return state.last_commit && state.last_commit.length > 0 ? state.last_commit : null;
}

function appendResumedLedgerEvent(
  repoRoot: string,
  packet: BootstrapPacket,
  state: Partial<LoopState>,
): void {
  const completedChildren = Array.isArray(state.completed_children)
    ? state.completed_children
    : [];
  const openChildren = Array.isArray(state.open_children)
    ? state.open_children
    : packet.open_children;

  new LedgerWriter(join(repoRoot, DEFAULT_LEDGER_PATH)).append({
    schema_version: 1,
    event_id: randomUUID(),
    event: "run-resumed",
    run_id: packet.run_id,
    run_type: normalizeRunType(state.session_type),
    cluster_id: state.cluster_id ?? null,
    issue_id: state.active_child || null,
    branch: state.branch ?? packet.branch,
    status: "running",
    completed_children: completedChildren,
    open_children: openChildren,
    next_child: state.next_open_child ?? openChildren[0] ?? null,
    last_commit: ledgerLastCommit(state),
    pr_url: null,
    timestamp: new Date().toISOString(),
    resume_source: "bootstrap",
    resume_reason: "polaris loop resume selected bootstrap packet",
  } satisfies RunResumedEvent);
}

export interface ResumeOptions {
  runId?: string;
  repoRoot: string;
  stateFile?: string;
}

export function runLoopResume(options: ResumeOptions): void {
  const { runId, repoRoot } = options;

  const config = loadConfig(repoRoot);
  const bootstrapDir = resolve(repoRoot, config.loop.bootstrapOutputPath ?? ".polaris/bootstrap");

  // Step 1: Read bootstrap packet
  let packet: BootstrapPacket;
  try {
    packet = readPacket(bootstrapDir, runId);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Step 2: Verify branch exists
  try {
    verifyBranch(packet.branch, repoRoot);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Step 3: Verify current-state SHA
  const stateFile =
    options.stateFile ??
    (packet.artifact_pointers.current_state.startsWith("/")
      ? packet.artifact_pointers.current_state
      : resolve(repoRoot, packet.artifact_pointers.current_state));

  let resumePacket = packet;
  let resumeState: LoopState;
  try {
    const resolved = resolveResumeState(repoRoot, packet, stateFile);
    resumePacket = resolved.packet;
    resumeState = resolved.state;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const actualSha = computeStateSha(stateFile);
  if (actualSha !== resumePacket.current_state_sha) {
    console.error(
      "state packet stale — re-run `polaris loop status` to verify current state",
    );
    process.exit(1);
  }

  // Step 4: Check allowBranchDivergence
  const allowDivergence = config.loop.allowBranchDivergence ?? false;
  if (!allowDivergence && packet.base_commit_sha) {
    const headSha = getHeadSha(repoRoot);
    if (headSha && headSha !== packet.base_commit_sha) {
      console.error(
        `branch HEAD changed since checkpoint (expected ${packet.base_commit_sha}, got ${headSha})`,
      );
      process.exit(1);
    }
  }

  // Step 5: Clear blocked status if state was blocked
  let ledgerState: Partial<LoopState> = resumeState;
  if (resumeState.status === "blocked") {
    ledgerState = {
      ...resumeState,
      status: "running",
      blocker: undefined,
    };
    const updatedSha = writeStateAtomic(stateFile, ledgerState as LoopState);
    resumePacket = {
      ...resumePacket,
      current_state_sha: updatedSha,
    };
  }

  appendResumedLedgerEvent(repoRoot, resumePacket, ledgerState);

  // Step 6: Emit bootstrap packet to stdout, exit 0
  console.log(JSON.stringify(resumePacket, null, 2));
}
