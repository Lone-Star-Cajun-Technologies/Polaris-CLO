import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readState } from "./checkpoint.js";
import { classifyArtifactPath } from "../finalize/artifact-policy.js";

interface ClusterStateSnapshot {
  commits?: Record<string, unknown>;
  result_pointers?: Record<string, unknown>;
  packet_pointers?: Record<string, unknown>;
  validation_results?: Record<string, unknown>;
}

interface WorkerPacketSnapshot {
  instructions?: Record<string, unknown>;
  artifact_only?: unknown;
  validation_waiver?: unknown;
}

interface ChildResultSnapshot {
  commit?: unknown;
  commit_hash?: unknown;
  validation?: unknown;
}

export interface FinalizeEvidenceFailure {
  childId: string;
  reasons: string[];
}

export interface FinalizeEvidenceReport {
  ok: boolean;
  failures: FinalizeEvidenceFailure[];
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function resolvePath(repoRoot: string, pathLike: unknown): string | undefined {
  if (typeof pathLike !== "string" || pathLike.trim().length === 0) return undefined;
  return isAbsolute(pathLike) ? pathLike : resolve(repoRoot, pathLike);
}

function pickCommitHash(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const commit = candidate.trim();
    if (commit.length > 0) return commit;
  }
  return undefined;
}

function packetFlag(packet: unknown, key: "artifact_only" | "validation_waiver"): unknown {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return undefined;
  const pkt = packet as WorkerPacketSnapshot;
  const fromRoot = pkt[key];
  if (fromRoot !== undefined) return fromRoot;
  const instructions = pkt.instructions;
  if (!instructions || typeof instructions !== "object" || Array.isArray(instructions)) return undefined;
  return instructions[key];
}

function hasValidationWaiver(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.keys(value).length > 0;
  return false;
}

function isArtifactOnlyAllowed(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function hasPassingValidation(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "passed" || normalized === "pass" || normalized === "success" || normalized === "ok";
  }
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (typeof status === "string" && ["passed", "pass", "success", "ok"].includes(status.trim().toLowerCase())) {
    return true;
  }
  const summary = record["summary"];
  if (typeof summary === "string" && ["passed", "pass", "success", "ok"].includes(summary.trim().toLowerCase())) {
    return true;
  }
  const validation = record["validation"];
  if (typeof validation === "string" && ["passed", "pass", "success", "ok"].includes(validation.trim().toLowerCase())) {
    return true;
  }
  const passed = record["passed"];
  if (passed === true) return true;
  if (Array.isArray(passed)) return passed.length > 0;
  if (typeof passed === "number") return passed > 0;
  return false;
}

function getCommitFiles(repoRoot: string, commitHash: string): string[] | null {
  try {
    const output = execFileSync(
      "git",
      ["show", "--pretty=format:", "--name-only", commitHash],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function listFailingChildren(failures: FinalizeEvidenceFailure[]): string {
  const lines = failures.map((failure) => `- ${failure.childId}: ${failure.reasons.join("; ")}`);
  return [
    "finalize aborted: completed children missing implementation evidence:",
    ...lines,
  ].join("\n");
}

export function formatFinalizeEvidenceFailures(failures: FinalizeEvidenceFailure[]): string {
  return listFailingChildren(failures);
}

export function verifyCompletedChildFinalizeEvidence(
  repoRoot: string,
  stateFile: string,
): FinalizeEvidenceReport {
  const state = readState(stateFile);
  const clusterStatePath = resolve(repoRoot, ".polaris", "clusters", state.cluster_id, "cluster-state.json");
  const clusterState = (readJsonFile(clusterStatePath) ?? {}) as ClusterStateSnapshot;

  const failures: FinalizeEvidenceFailure[] = [];
  for (const childId of state.completed_children) {
    const reasons: string[] = [];
    const childMeta = state.open_children_meta?.[childId];
    const dispatchRecord = childMeta?.dispatch_record;

    const packetPath = resolvePath(
      repoRoot,
      dispatchRecord?.packet_path ?? clusterState.packet_pointers?.[childId],
    );
    const resultPath = resolvePath(
      repoRoot,
      dispatchRecord?.expected_result_path ?? childMeta?.result_file ?? clusterState.result_pointers?.[childId],
    );

    const packet = packetPath ? readJsonFile(packetPath) : undefined;
    const result = (resultPath ? readJsonFile(resultPath) : undefined) as ChildResultSnapshot | undefined;

    const stateResult = state.completed_children_results?.[childId];
    const commitHash = pickCommitHash(
      clusterState.commits?.[childId],
      stateResult?.commit,
      result?.commit,
      result?.commit_hash,
    );

    if (!commitHash) {
      reasons.push("no commit hash recorded in cluster state or result evidence");
    } else {
      const commitFiles = getCommitFiles(repoRoot, commitHash);
      if (commitFiles === null) {
        reasons.push(`commit ${commitHash} not found in git history`);
      } else if (commitFiles.length === 0) {
        reasons.push(`commit ${commitHash} contains no file changes`);
      } else {
        const nonArtifactFiles = commitFiles.filter(
          (file) => classifyArtifactPath(file, state.cluster_id) === "non-artifact",
        );
        const artifactOnlyAllowed = isArtifactOnlyAllowed(packetFlag(packet, "artifact_only"));
        if (nonArtifactFiles.length === 0 && !artifactOnlyAllowed) {
          reasons.push(
            `commit ${commitHash} changes only artifacts and packet is missing artifact_only: true`,
          );
        }
      }
    }

    const validationWaiver = packetFlag(packet, "validation_waiver");
    const validationPassed = hasPassingValidation(result?.validation)
      || hasPassingValidation(stateResult?.validation)
      || hasPassingValidation(clusterState.validation_results?.[childId]);
    if (!validationPassed && !hasValidationWaiver(validationWaiver)) {
      reasons.push("validation evidence missing or not passed and no validation_waiver was provided");
    }

    if (reasons.length > 0) {
      failures.push({ childId, reasons });
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

export function assertFinalizeEvidenceOrThrow(repoRoot: string, stateFile: string): void {
  const report = verifyCompletedChildFinalizeEvidence(repoRoot, stateFile);
  if (!report.ok) {
    throw new Error(formatFinalizeEvidenceFailures(report.failures));
  }
}
