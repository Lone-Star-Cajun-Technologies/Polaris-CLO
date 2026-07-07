import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { QcResult } from "./types.js";
import { validateQcResult } from "./schemas.js";

/**
 * Returns the cluster-scoped QC evidence directory.
 * Artifacts live under `.polaris/clusters/<cluster-id>/qc/` so that finalize's
 * artifact policy can promote them as durable evidence.
 */
export function getQcArtifactDir(clusterId: string, repoRoot?: string): string {
  return path.join(repoRoot || process.cwd(), ".polaris", "clusters", clusterId, "qc");
}

function getArtifactPath(clusterId: string, qcRunId: string, repoRoot?: string): string {
  return path.join(getQcArtifactDir(clusterId, repoRoot), `${qcRunId}.json`);
}

/**
 * Write a normalized QC result under the active cluster's evidence surface.
 * The file is written atomically via a temp file + rename.
 * Returns the absolute artifact path.
 */
export function writeQcArtifact(
  clusterId: string,
  result: QcResult,
  repoRoot?: string,
): string {
  const artifactDir = getQcArtifactDir(clusterId, repoRoot);
  mkdirSync(artifactDir, { recursive: true });

  const artifactPath = getArtifactPath(clusterId, result.qcRunId, repoRoot);
  const tempPath = `${artifactPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  try {
    writeFileSync(tempPath, JSON.stringify(result, null, 2), "utf-8");
    renameSync(tempPath, artifactPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failure.
    }
    throw error;
  }

  return artifactPath;
}

/**
 * Read a QC artifact by its run id.
 * Returns null if the file does not exist or fails validation.
 */
export function readQcArtifact(
  clusterId: string,
  qcRunId: string,
  repoRoot?: string,
): QcResult | null {
  const artifactPath = getArtifactPath(clusterId, qcRunId, repoRoot);
  try {
    const data = readFileSync(artifactPath, "utf-8");
    const parsed = JSON.parse(data) as unknown;
    const validation = validateQcResult(parsed);
    if (!validation.success) {
      return null;
    }
    return validation.result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * List persisted QC run ids for a cluster.
 */
export function listQcArtifactIds(clusterId: string, repoRoot?: string): string[] {
  const artifactDir = getQcArtifactDir(clusterId, repoRoot);
  try {
    return readdirSync(artifactDir, "utf-8")
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
