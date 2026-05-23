import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import type { BootstrapPacket } from "./bootstrap-packet.js";

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
    const match = entries.find((f) => f.startsWith(`${runId}-`));
    if (!match) {
      throw new Error(`No bootstrap packet found for run_id "${runId}" in ${bootstrapDir}`);
    }
    target = match;
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

  // Step 5-6: Emit bootstrap packet to stdout, exit 0
  console.log(JSON.stringify(packet, null, 2));
}
