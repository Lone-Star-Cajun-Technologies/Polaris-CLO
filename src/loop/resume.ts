import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { readState, writeStateAtomic, type LoopState } from "./checkpoint.js";
import type { BootstrapPacket } from "./bootstrap-packet.js";
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

  let actualSha: string;
  try {
    actualSha = computeStateSha(stateFile);
  } catch {
    console.error(`Error: cannot read state file ${stateFile}`);
    process.exit(1);
  }

  if (actualSha !== packet.current_state_sha) {
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
  let resumeState: Partial<LoopState> = {};
  try {
    const currentState = readState(stateFile);
    if (currentState.status === "blocked") {
      resumeState = {
        ...currentState,
        status: "running",
        blocker: undefined,
      };
      writeStateAtomic(stateFile, resumeState as LoopState);
    } else {
      resumeState = currentState;
    }
  } catch {
    // Non-fatal: state read for clearing blocked status failed; proceed
  }

  appendResumedLedgerEvent(repoRoot, packet, resumeState);

  // Step 6: Emit bootstrap packet to stdout, exit 0
  console.log(JSON.stringify(packet, null, 2));
}
