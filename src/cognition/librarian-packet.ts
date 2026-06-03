/**
 * Generates a CloseoutLibrarianPacket for a completed cluster.
 *
 * Called by `polaris librarian packet <cluster-id>`.
 * Writes the packet to .polaris/clusters/<cluster-id>/packets/librarian-packet-<dispatch-id>.json
 * and prints the absolute path to stdout.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readState } from "../loop/checkpoint.js";
import type {
  CloseoutLibrarianPacket,
  ChildSummary,
  FolderCognitionPaths,
} from "./closeout-librarian-types.js";

export interface GenerateLibrarianPacketOptions {
  repoRoot: string;
  clusterId: string;
  stateFile?: string;
}

export function generateLibrarianPacket(options: GenerateLibrarianPacketOptions): string {
  const { repoRoot, clusterId } = options;
  const stateFile = options.stateFile ?? resolveStateFile(repoRoot, clusterId);
  const state = readState(stateFile);

  if (state.cluster_id !== clusterId) {
    throw new Error(
      `State file cluster_id "${state.cluster_id}" does not match requested cluster "${clusterId}".`,
    );
  }
  if (state.status !== "cluster-complete") {
    throw new Error(
      `Cluster "${clusterId}" is not complete (status: "${state.status}"). ` +
        `All children must be done before dispatching the Closeout Librarian.`,
    );
  }
  if (state.completed_children.length === 0) {
    throw new Error(`Cluster "${clusterId}" has no completed children.`);
  }

  const dispatchId = randomUUID();
  const resultsDir = path.join(repoRoot, ".polaris", "clusters", clusterId, "results");
  const artifactDir =
    state.artifact_dir ?? path.join(repoRoot, ".taskchain_artifacts", "polaris-run");
  const telemetryFile = path.join(artifactDir, "runs", state.run_id, "telemetry.jsonl");

  // Build per-child summaries
  const childSummaries: ChildSummary[] = state.completed_children.map((childId) => {
    const resultFile = findResultFile(resultsDir, childId);
    const result = resultFile ? readJsonFile(resultFile) : null;
    const commitSha = typeof result?.["commit"] === "string" ? result["commit"] : null;
    const changedFiles = commitSha ? getCommitFiles(repoRoot, commitSha) : [];
    const cognitionNotePath = findCognitionNote(repoRoot, childId);

    return {
      child_id: childId,
      title: state.open_children_meta?.[childId]?.title ?? childId,
      commit_sha: commitSha,
      changed_files: changedFiles,
      compact_return_path: resultFile ? path.relative(repoRoot, resultFile) : null,
      cognition_note_path: cognitionNotePath,
    };
  });

  // Derive affected folders from all changed files across all children
  const allChangedFiles = childSummaries.flatMap((s) => s.changed_files);
  const affectedFolders = computeAffectedFolders(repoRoot, allChangedFiles);

  // Build per-folder cognition paths
  const polarisMdPaths: FolderCognitionPaths[] = affectedFolders.map((folder) => {
    const slug = folder.replace(/\/+$/, "").replace(/[^a-zA-Z0-9]+/g, "-");
    const summaryAbs = path.join(repoRoot, folder, "SUMMARY.md");
    const cognitionIndexAbs = path.join(
      repoRoot,
      ".polaris",
      "cognition",
      "index",
      `${slug}.json`,
    );
    return {
      folder,
      folder_slug: slug,
      polaris_md: path.join(folder, "POLARIS.md"),
      summary_md: fs.existsSync(summaryAbs) ? path.join(folder, "SUMMARY.md") : null,
      cognition_index: fs.existsSync(cognitionIndexAbs)
        ? path.relative(repoRoot, cognitionIndexAbs)
        : null,
    };
  });

  const cognitionNotes = findPendingCognitionNotes(repoRoot, state.completed_children);
  const cognitionArchivePaths = findCognitionArchivePaths(repoRoot, affectedFolders);
  const smartdocsRawPaths = findSmartdocsRaw(repoRoot);
  const existingSpecs = findActiveSpecs(repoRoot);
  const existingDoctrine = findActiveDoctrine(repoRoot);
  const runReportPath = findRunReport(repoRoot, state.run_id);

  const packetDir = path.join(repoRoot, ".polaris", "clusters", clusterId, "packets");
  const resultDir = path.join(repoRoot, ".polaris", "clusters", clusterId, "results");
  const resultPath = path.join(resultDir, `librarian-${dispatchId}.json`);

  // Prohibited: anything that is not documentation or cognition
  const prohibitedWritePaths = [
    stateFile,
    path.join(repoRoot, ".polaris", "clusters", clusterId, "state.json"),
    path.join(repoRoot, ".taskchain_artifacts"),
    path.join(repoRoot, ".polaris", "runs"),
    path.join(repoRoot, ".polaris", "map"),
    packetDir,
    resultDir,
    telemetryFile,
    path.join(repoRoot, "src"),
    path.join(repoRoot, "test"),
    path.join(repoRoot, "scripts"),
  ];

  // Allowed: documentation and cognition paths only
  const allowedWritePaths = [
    ...polarisMdPaths.map((p) => path.join(repoRoot, p.polaris_md)),
    ...polarisMdPaths.filter((p) => p.summary_md).map((p) => path.join(repoRoot, p.summary_md!)),
    path.join(repoRoot, "smartdocs"),
    path.join(repoRoot, ".polaris", "cognition", "archive"),
    resultPath,
  ];

  const packet: CloseoutLibrarianPacket = {
    schema_version: "1.0",
    role: "closeout-librarian",
    run_id: state.run_id,
    dispatch_id: dispatchId,
    cluster_id: clusterId,
    completed_children: state.completed_children,
    child_summaries: childSummaries,
    run_report_path: runReportPath,
    current_state_path: path.relative(repoRoot, stateFile),
    affected_folders: affectedFolders,
    polaris_md_paths: polarisMdPaths,
    cognition_notes: cognitionNotes,
    cognition_archive_paths: cognitionArchivePaths,
    smartdocs_raw_paths: smartdocsRawPaths,
    existing_specs: existingSpecs,
    existing_doctrine: existingDoctrine,
    result_path: resultPath,
    prohibited_write_paths: prohibitedWritePaths,
    allowed_write_paths: allowedWritePaths,
    constraints: {
      max_summary_addition_lines: 50,
      require_polaris_confidence_threshold: 0.8,
      librarian_timeout_seconds: 600,
    },
  };

  fs.mkdirSync(packetDir, { recursive: true });
  const packetPath = path.join(packetDir, `librarian-packet-${dispatchId}.json`);
  fs.writeFileSync(packetPath, JSON.stringify(packet, null, 2), "utf-8");

  process.stdout.write(`${packetPath}\n`);
  return packetPath;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveStateFile(repoRoot: string, clusterId: string): string {
  const canonical = path.join(repoRoot, ".polaris", "clusters", clusterId, "state.json");
  if (fs.existsSync(canonical)) return canonical;
  const taskchain = path.join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
  if (fs.existsSync(taskchain)) return taskchain;
  const legacy = path.join(repoRoot, ".polaris", "runs", "current-state.json");
  if (fs.existsSync(legacy)) return legacy;
  return canonical;
}

function findResultFile(resultsDir: string, childId: string): string | null {
  try {
    const files = fs
      .readdirSync(resultsDir)
      .filter((f) => f.startsWith(`${childId}-`) && f.endsWith(".json"))
      .sort();
    if (files.length === 0) return null;
    return path.join(resultsDir, files[files.length - 1]!);
  } catch {
    return null;
  }
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getCommitFiles(repoRoot: string, commitSha: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["show", "--name-only", "--format=", commitSha],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function findCognitionNote(repoRoot: string, childId: string): string | null {
  const pendingDir = path.join(repoRoot, ".polaris", "cognition", "pending");
  const candidates = [
    path.join(pendingDir, `${childId}.md`),
    path.join(pendingDir, `${childId}.json`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.relative(repoRoot, candidate);
  }
  // Also try scanning for files that start with the child ID
  try {
    const found = fs
      .readdirSync(pendingDir)
      .find((f) => f.startsWith(childId + "-") || f.startsWith(childId + "."));
    if (found) return path.relative(repoRoot, path.join(pendingDir, found));
  } catch {
    // ignore
  }
  return null;
}

function computeAffectedFolders(repoRoot: string, changedFiles: string[]): string[] {
  const skip = new Set([".polaris", "node_modules", ".taskchain_artifacts", ".github"]);
  const folders = new Set<string>();

  for (const file of changedFiles) {
    const parts = file.split("/");
    if (skip.has(parts[0] ?? "")) continue;

    // Walk up from the file's directory toward root, collecting folders with POLARIS.md
    for (let depth = 1; depth <= parts.length - 1; depth++) {
      const folder = parts.slice(0, depth).join("/");
      if (fs.existsSync(path.join(repoRoot, folder, "POLARIS.md"))) {
        folders.add(folder + "/");
      }
    }
  }

  return [...folders].sort();
}

function findPendingCognitionNotes(repoRoot: string, childIds: string[]): string[] {
  const pendingDir = path.join(repoRoot, ".polaris", "cognition", "pending");
  const results: string[] = [];
  try {
    const files = fs.readdirSync(pendingDir);
    for (const file of files) {
      const base = path.basename(file, path.extname(file));
      if (childIds.some((id) => base === id || base.startsWith(id + "-"))) {
        results.push(path.relative(repoRoot, path.join(pendingDir, file)));
      }
    }
  } catch {
    // no pending dir — normal
  }
  return results;
}

function findCognitionArchivePaths(repoRoot: string, affectedFolders: string[]): string[] {
  const archiveDir = path.join(repoRoot, ".polaris", "cognition", "archive");
  const results: string[] = [];
  try {
    const slugs = new Set(
      affectedFolders.map((f) => f.replace(/\/+$/, "").replace(/[^a-zA-Z0-9]+/g, "-")),
    );
    const files = fs.readdirSync(archiveDir);
    for (const file of files) {
      const slug = path.basename(file, path.extname(file)).replace(/-\d{4}-\d{2}-.*$/, "");
      if (slugs.has(slug)) {
        results.push(path.relative(repoRoot, path.join(archiveDir, file)));
      }
    }
  } catch {
    // no archive dir — normal
  }
  return results;
}

function findSmartdocsRaw(repoRoot: string): string[] {
  const candidates = [
    path.join(repoRoot, "smartdocs", "raw"),
    path.join(repoRoot, "smartdocs", "docs", "raw"),
  ];
  const results: string[] = [];
  for (const dir of candidates) {
    try {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of files) {
        if (entry.isFile()) {
          results.push(path.relative(repoRoot, path.join(dir, entry.name)));
        }
      }
    } catch {
      // directory may not exist
    }
  }
  return results;
}

function findActiveSpecs(repoRoot: string): string[] {
  const specsDir = path.join(repoRoot, "smartdocs", "specs", "active");
  return listMarkdownFiles(repoRoot, specsDir);
}

function findActiveDoctrine(repoRoot: string): string[] {
  const doctrineDir = path.join(repoRoot, "smartdocs", "doctrine", "active");
  return listMarkdownFiles(repoRoot, doctrineDir);
}

function listMarkdownFiles(repoRoot: string, dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.relative(repoRoot, path.join(dir, f)));
  } catch {
    return [];
  }
}

function findRunReport(repoRoot: string, runId: string): string | null {
  const candidates = [
    path.join(repoRoot, ".taskchain_artifacts", "polaris-run", "runs", runId, "run-report.md"),
    path.join(repoRoot, ".polaris", "runs", runId, "run-report.md"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.relative(repoRoot, candidate);
  }
  return null;
}
