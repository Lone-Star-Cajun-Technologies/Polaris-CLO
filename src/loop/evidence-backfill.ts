import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { readState } from "./checkpoint.js";
import { readClusterStateSync, writeClusterStateSync } from "../cluster-state/store.js";
import type { ClusterState, ValidationResult } from "../cluster-state/types.js";

// Aligns with the guard in continue.ts: case-insensitive, ≥7 hex chars, no upper cap
// (accepts SHA-256 repos with 64-char hashes and uppercase object names).
const HEX_SHA_RE = /^[0-9a-f]{7,}$/i;

export function isPlaceholderCommit(commit: unknown): boolean {
  if (typeof commit !== "string" || commit.trim().length === 0) return true;
  return !HEX_SHA_RE.test(commit.trim());
}

function readJsonFile(filePath: string): unknown | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

// Scan a directory for the first (sorted) file whose name starts with `<childId>-` or equals `<childId>.json`.
// Sorting makes selection deterministic even when multiple result/packet files exist for the same child.
function findFileByChildPrefix(dir: string, childId: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const entries = readdirSync(dir).sort();
  const match = entries.find(
    (name) => name === `${childId}.json` || name.startsWith(`${childId}-`),
  );
  return match ? join(dir, match) : undefined;
}

function hasPassingValidation(value: unknown): boolean {
  if (typeof value === "string") {
    const n = value.trim().toLowerCase();
    return n === "passed" || n === "pass" || n === "success" || n === "ok";
  }
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const passed = rec["passed"];
  if (passed === true) return true;
  if (Array.isArray(passed) && passed.length > 0) return true;
  if (typeof passed === "number" && passed > 0) return true;
  for (const key of ["status", "summary", "validation"]) {
    const v = rec[key];
    if (typeof v === "string" && ["passed", "pass", "success", "ok"].includes(v.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

function hasValidationWaiver(packet: unknown): boolean {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return false;
  const pkt = packet as Record<string, unknown>;
  const isTruthy = (v: unknown) => {
    if (typeof v === "string") return v.trim().length > 0;
    if (typeof v === "boolean") return v;
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.keys(v as object).length > 0;
    return false;
  };
  if (isTruthy(pkt["validation_waiver"])) return true;
  const instr = pkt["instructions"];
  if (instr && typeof instr === "object" && !Array.isArray(instr)) {
    if (isTruthy((instr as Record<string, unknown>)["validation_waiver"])) return true;
  }
  return false;
}

export interface BackfillSuccess {
  childId: string;
  resultFile: string;
  packetFile: string | undefined;
  commit: string;
  validationPassed: boolean;
}

export interface BackfillSkip {
  childId: string;
  reason: string;
}

export interface BackfillReport {
  clusterId: string;
  backfilled: BackfillSuccess[];
  skipped: BackfillSkip[];
}

export interface BackfillOptions {
  repoRoot: string;
  stateFile: string;
  dryRun?: boolean;
}

export function backfillClusterStateEvidence(options: BackfillOptions): BackfillReport {
  const { repoRoot, stateFile, dryRun = false } = options;
  const state = readState(stateFile);
  const clusterId = state.cluster_id;

  const resultsDir = join(repoRoot, ".polaris", "clusters", clusterId, "results");
  const packetsDir = join(repoRoot, ".polaris", "clusters", clusterId, "packets");

  const backfilled: BackfillSuccess[] = [];
  const skipped: BackfillSkip[] = [];

  for (const childId of state.completed_children) {
    // Resolve result file — mirrors continue.ts priority:
    //   1. result_file on child meta (explicit override, e.g. --result-file flag)
    //   2. dispatch_record.expected_result_path
    //   3. directory scan by child ID prefix (fallback for older state)
    let resultFilePath: string | undefined;
    const childMeta = state.open_children_meta?.[childId];
    const dispatchRecord = childMeta?.dispatch_record;
    for (const candidate of [childMeta?.result_file, dispatchRecord?.expected_result_path]) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        const abs = resolve(repoRoot, candidate);
        if (existsSync(abs)) { resultFilePath = abs; break; }
      }
    }
    if (!resultFilePath) {
      resultFilePath = findFileByChildPrefix(resultsDir, childId);
    }

    if (!resultFilePath) {
      skipped.push({ childId, reason: "no result file found" });
      continue;
    }

    const result = readJsonFile(resultFilePath) as Record<string, unknown> | undefined;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      skipped.push({ childId, reason: "result file unreadable or not a JSON object" });
      continue;
    }

    // Reject placeholder commits.
    const rawCommit = result["commit"] ?? result["commit_hash"];
    if (isPlaceholderCommit(rawCommit)) {
      skipped.push({ childId, reason: `placeholder or missing commit: ${String(rawCommit ?? "(none)")}` });
      continue;
    }
    const commit = (rawCommit as string).trim();

    // Validate — or check for waiver.
    let packetFilePath: string | undefined;
    if (dispatchRecord?.packet_path) {
      const abs = resolve(repoRoot, dispatchRecord.packet_path);
      if (existsSync(abs)) packetFilePath = abs;
    }
    if (!packetFilePath) {
      packetFilePath = findFileByChildPrefix(packetsDir, childId);
    }

    const packet = packetFilePath ? readJsonFile(packetFilePath) : undefined;
    const validationPassed = hasPassingValidation(result["validation"]);

    if (!validationPassed && !hasValidationWaiver(packet)) {
      skipped.push({ childId, reason: "validation not passed and no validation_waiver on packet" });
      continue;
    }

    backfilled.push({
      childId,
      resultFile: relative(repoRoot, resultFilePath),
      packetFile: packetFilePath ? relative(repoRoot, packetFilePath) : undefined,
      commit,
      validationPassed,
    });
  }

  if (!dryRun && backfilled.length > 0) {
    applyBackfillToClusterState({ clusterId, repoRoot, backfilled });
  }

  return { clusterId, backfilled, skipped };
}

function applyBackfillToClusterState(params: {
  clusterId: string;
  repoRoot: string;
  backfilled: BackfillSuccess[];
}): void {
  const { clusterId, repoRoot, backfilled } = params;

  const existing = readClusterStateSync(clusterId, repoRoot);
  if (!existing) {
    throw new Error(`cluster-state.json not found for ${clusterId} — cannot apply backfill`);
  }

  const updatedClaimMetadata = { ...existing.claim_metadata };

  const updated: ClusterState = {
    ...existing,
    state_generation: existing.state_generation + 1,
    commits: { ...existing.commits },
    result_pointers: { ...existing.result_pointers },
    packet_pointers: { ...existing.packet_pointers },
    validation_results: { ...existing.validation_results },
    claim_metadata: updatedClaimMetadata,
    child_states: existing.child_states.map((cs) => ({ ...cs })),
  };

  for (const entry of backfilled) {
    updated.commits[entry.childId] = entry.commit;
    updated.result_pointers[entry.childId] = entry.resultFile;
    if (entry.packetFile) {
      updated.packet_pointers[entry.childId] = entry.packetFile;
    }
    const validationResult: ValidationResult = {
      passed: entry.validationPassed,
      output: `backfilled from ${entry.resultFile}`,
    };
    updated.validation_results[entry.childId] = validationResult;

    // Evict stale claim so child is no longer shown as claimed/dispatched.
    delete updatedClaimMetadata[entry.childId];

    const childState = updated.child_states.find((cs) => cs.id === entry.childId);
    if (childState) {
      childState.status = "done";
      childState.commit = entry.commit;
    } else {
      updated.child_states.push({ id: entry.childId, status: "done", commit: entry.commit });
    }
  }

  writeClusterStateSync(clusterId, updated, repoRoot);
}
