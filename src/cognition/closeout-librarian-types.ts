/**
 * Types and schema validator for the closeout-librarian role.
 *
 * The Closeout Librarian runs exactly once per completed cluster, after all
 * children are done and before PR creation. It reconciles cluster work into
 * project cognition (POLARIS.md, SUMMARY.md), ingests documentation, validates
 * links, and commits all documentation changes as a single librarian commit.
 *
 * The Librarian may NOT modify implementation code, runtime state, dispatch
 * workers, or create PRs.
 *
 * Spec: smartdocs/specs/active/closeout-librarian-spec.md
 */

/** Per-child summary included in the Librarian packet. */
export interface ChildSummary {
  child_id: string;
  title: string;
  commit_sha: string | null;
  changed_files: string[];
  /** Repo-relative path to the CompactReturn result JSON for this child. */
  compact_return_path: string | null;
  /** Repo-relative path to the worker cognition note for this child (null if not written). */
  cognition_note_path: string | null;
}

/** Per-folder cognition file paths included in the Librarian packet. */
export type RouteArtifactIntent = "must-reconcile" | "reconcile-if-present" | "not-present";

export interface RouteArtifactContract {
  /** Repo-relative path to the artifact, or null when the artifact does not exist. */
  path: string | null;
  /** Artifact-specific reconciliation intent for this folder. */
  intent: RouteArtifactIntent;
  /** Why this artifact should (or should not) be reconciled for the folder. */
  reason: string;
}

export interface FolderCognitionPaths {
  /** Repo-relative folder path (e.g. "src/loop/"). */
  folder: string;
  /** Slug derived from folder path (e.g. "src-loop"). */
  folder_slug: string;
  /** Repo-relative path to the folder's current POLARIS.md. */
  polaris_md: string;
  /** Repo-relative path to the folder's current SUMMARY.md, or null if absent. */
  summary_md: string | null;
  /** Repo-relative path to the cognition-index.json for this folder, or null if absent. */
  cognition_index: string | null;
  /** Explicit per-artifact reconciliation contract for this folder. */
  artifact_contract: {
    polaris_md: RouteArtifactContract;
    summary_md: RouteArtifactContract;
  };
}

/** Constraint configuration for the Closeout Librarian. */
export interface CloseoutConstraints {
  /** Maximum net new lines per SUMMARY.md update. Default: 50. */
  max_summary_addition_lines: number;
  /** Minimum confidence score to apply POLARIS.md patches (0.0–1.0). Default: 0.80. */
  require_polaris_confidence_threshold: number;
  /** Timeout in seconds before Foreman escalates on missing result. Default: 600. */
  librarian_timeout_seconds: number;
}

/** The packet dispatched to the Closeout Librarian by the Foreman. */
export interface CloseoutLibrarianPacket {
  schema_version: "1.0";
  role: "closeout-librarian";
  run_id: string;
  dispatch_id: string;
  cluster_id: string;

  /** Ordered list of completed child IDs (in completion order). */
  completed_children: string[];

  /** Per-child metadata for all completed children. */
  child_summaries: ChildSummary[];

  /** Repo-relative path to the generated run-report.md. Null if not yet generated. */
  run_report_path: string | null;

  /** Repo-relative path to current-state.json (read-only). */
  current_state_path: string;

  /** Folders affected by this cluster (derived from child changed_files). */
  affected_folders: string[];

  /** Per-folder cognition file paths for all affected folders. */
  polaris_md_paths: FolderCognitionPaths[];

  /** Repo-relative paths to pending cognition notes from this cluster. */
  cognition_notes: string[];

  /** Repo-relative paths to cognition-index.json files for affected folders. */
  cognition_archive_paths: string[];

  /** Repo-relative paths to raw SmartDocs files that may need ingestion. */
  smartdocs_raw_paths: string[];

  /** Repo-relative paths to existing active specs that are relevant to this work. */
  existing_specs: string[];

  /** Repo-relative paths to existing active doctrine relevant to this work. */
  existing_doctrine: string[];

  /** Absolute path where the Librarian must write its sealed CloseoutLibrarianResult JSON. */
  result_path: string;

  /**
   * Paths the Librarian must NOT write to.
   * Includes all runtime state files, source code, and implementation artifacts.
   */
  prohibited_write_paths: string[];

  /**
   * Paths the Librarian is permitted to write to.
   * Includes POLARIS.md, SUMMARY.md (affected folders), smartdocs targets,
   * cognition archive paths, and the result_path.
   */
  allowed_write_paths: string[];

  constraints: CloseoutConstraints;
}

/** A file update produced by the Closeout Librarian. */
export interface CloseoutFileUpdate {
  /** Repo-relative path of the file updated or created. */
  file: string;
  action: "update" | "create";
  /** ≤50-word summary of what changed. */
  change_summary: string;
}

/** A documentation ingestion or archival action. */
export interface DocAction {
  /** Repo-relative path of the source document. */
  source_path: string;
  /** Repo-relative path of the target location (null for archive-only). */
  target_path: string | null;
  action: "ingest" | "promote" | "archive" | "skip";
  reason: string;
}

/** An archived cognition note entry. */
export interface CognitionArchiveEntry {
  /** Source path in .polaris/cognition/pending/. */
  note_path: string;
  /** Destination path in .polaris/cognition/archive/. */
  archive_path: string;
}

/** Link validation report produced by the Closeout Librarian. */
export interface LinkValidationReport {
  total_checked: number;
  valid: number;
  broken: number;
  repaired: number;
  /** Human-readable descriptions of links that could not be repaired. */
  unrepairable: string[];
}

/** A blocker recorded by the Closeout Librarian. */
export interface LibrarianBlocker {
  type:
    | "link-unrepairable"
    | "conflict-detected"
    | "low-confidence"
    | "write-prohibited"
    | "commit-failed"
    | "packet-invalid"
    | "librarian-timeout"
    | "result-write-failed";
  description: string;
  /** Repo-relative path of the affected file (if applicable). */
  affected_file?: string;
  /** Whether the Foreman must halt and escalate before proceeding. */
  resolution_required: boolean;
}

/** The sealed result written by the Closeout Librarian to result_path. */
export type ArtifactReconciliationDecision =
  | "polaris-only"
  | "summary-only"
  | "both"
  | "no-change";

export interface ArtifactReconciliationUpdate {
  /** Folder whose route artifacts were evaluated for reconciliation. */
  folder: string;
  /**
   * Explicit artifact-level decision:
   * - polaris-only: only POLARIS.md changed
   * - summary-only: only SUMMARY.md changed
   * - both: both artifacts changed
   * - no-change: neither artifact changed
   */
  decision: ArtifactReconciliationDecision;
  /** Repo-relative POLARIS.md path for the folder (always expected for affected folders). */
  polaris_md: string;
  /** Repo-relative SUMMARY.md path for the folder, or null when the file does not exist. */
  summary_md: string | null;
  /** Why this reconciliation decision was chosen for the folder. */
  reason: string;
}

export interface CloseoutLibrarianResult {
  schema_version: "1.0";
  role: "closeout-librarian";
  run_id: string;
  dispatch_id: string;
  cluster_id: string;

  /**
   * - `"success"`: all work completed, no blocking issues
   * - `"partial"`: some work done, some could not be completed (recoverable blockers)
   * - `"blocked"`: significant blockers prevent meaningful reconciliation
   * - `"failure"`: commit failed, packet invalid, or result could not be written
   */
  status: "success" | "partial" | "blocked" | "failure";

  /** Git commit SHA of the librarian commit, or null if no documentation changes needed. */
  commit_sha: string | null;

  /** Commit message used for the librarian commit. */
  commit_message: string;

  /** Repo-relative paths of files included in the librarian commit. */
  files_committed: string[];

  /** POLARIS.md files updated in step 02. */
  polaris_md_updates: CloseoutFileUpdate[];

  /** SUMMARY.md files updated in step 03. */
  summary_md_updates: CloseoutFileUpdate[];

  /** Per-folder artifact reconciliation decisions (optional for backward compatibility). */
  artifact_reconciliation?: ArtifactReconciliationUpdate[];

  /** Documentation ingested or promoted in step 04. */
  docs_ingested: DocAction[];

  /** Documentation archived in step 04. */
  docs_archived: DocAction[];

  /** YAML frontmatter and reference updates from step 06. */
  yaml_updates: CloseoutFileUpdate[];

  /** Cognition notes archived in step 04. */
  cognition_archived: CognitionArchiveEntry[];

  /** Link validation report from step 05. */
  link_validation: LinkValidationReport;

  /** Blockers accumulated across all steps. */
  blockers: LibrarianBlocker[];

  /** ISO8601 timestamp when the Librarian completed. */
  reconciled_at: string;

  /** ≤200-word human-readable summary of what was done and what remains. */
  evidence_summary: string;
}

/**
 * Validate a CloseoutLibrarianPacket. Returns an array of error strings; empty means valid.
 *
 * Performs lightweight top-level checks only: object presence, required field types,
 * enum values, and array presence. Does NOT validate nested element schemas (e.g.,
 * individual child_summaries entries), string formats (e.g., ISO dates), or cross-field
 * consistency. Further semantic validation is performed by the Foreman via
 * checkLibrarianResultGate and other runtime-spec result checks before finalize.
 */
export function validateCloseoutLibrarianPacket(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["CloseoutLibrarianPacket must be a JSON object"];
  }
  const p = value as Record<string, unknown>;

  if (p["role"] !== "closeout-librarian") {
    errors.push('role must be "closeout-librarian"');
  }
  if (p["schema_version"] !== "1.0") {
    errors.push('schema_version must be "1.0"');
  }
  if (typeof p["run_id"] !== "string" || !p["run_id"]) {
    errors.push("missing or empty run_id");
  }
  if (typeof p["dispatch_id"] !== "string" || !p["dispatch_id"]) {
    errors.push("missing or empty dispatch_id");
  }
  if (typeof p["cluster_id"] !== "string" || !p["cluster_id"]) {
    errors.push("missing or empty cluster_id");
  }
  if (!Array.isArray(p["completed_children"]) || p["completed_children"].length === 0) {
    errors.push("completed_children must be a non-empty array");
  }
  if (!Array.isArray(p["child_summaries"])) {
    errors.push("child_summaries must be an array");
  }
  if (!Array.isArray(p["affected_folders"])) {
    errors.push("affected_folders must be an array");
  }
  if (!Array.isArray(p["polaris_md_paths"])) {
    errors.push("polaris_md_paths must be an array");
  }
  if (typeof p["result_path"] !== "string" || !p["result_path"]) {
    errors.push("missing or empty result_path");
  }
  if (!Array.isArray(p["prohibited_write_paths"])) {
    errors.push("prohibited_write_paths must be an array");
  }
  if (!Array.isArray(p["allowed_write_paths"])) {
    errors.push("allowed_write_paths must be an array");
  }

  return errors;
}

/**
 * Validate a CloseoutLibrarianResult. Returns an array of error strings; empty means valid.
 *
 * Performs lightweight top-level checks only: object presence, required field types,
 * enum values, and array presence. Does NOT validate nested element schemas, string
 * formats (e.g., reconciled_at ISO date), or cross-field consistency (e.g., whether
 * commit_sha matches files_committed). Further semantic validation is performed by the
 * Foreman via checkLibrarianResultGate and other runtime-spec result checks before finalize.
 */
export function validateCloseoutLibrarianResult(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["CloseoutLibrarianResult must be a JSON object"];
  }
  const r = value as Record<string, unknown>;

  if (r["role"] !== "closeout-librarian") {
    errors.push('role must be "closeout-librarian"');
  }
  if (r["schema_version"] !== "1.0") {
    errors.push('schema_version must be "1.0"');
  }
  if (typeof r["run_id"] !== "string" || !r["run_id"]) {
    errors.push("missing or empty run_id");
  }
  if (typeof r["dispatch_id"] !== "string" || !r["dispatch_id"]) {
    errors.push("missing or empty dispatch_id");
  }
  if (typeof r["cluster_id"] !== "string" || !r["cluster_id"]) {
    errors.push("missing or empty cluster_id");
  }

  const validStatuses = ["success", "partial", "blocked", "failure"];
  if (!validStatuses.includes(r["status"] as string)) {
    errors.push(`status must be one of: ${validStatuses.join(", ")}`);
  }

  if (r["commit_sha"] !== null && typeof r["commit_sha"] !== "string") {
    errors.push("commit_sha must be a string or null");
  }
  if (typeof r["commit_message"] !== "string") {
    errors.push("commit_message must be a string");
  }
  if (!Array.isArray(r["files_committed"])) {
    errors.push("files_committed must be an array");
  }
  if (!Array.isArray(r["polaris_md_updates"])) {
    errors.push("polaris_md_updates must be an array");
  }
  if (!Array.isArray(r["summary_md_updates"])) {
    errors.push("summary_md_updates must be an array");
  }
  if (
    r["artifact_reconciliation"] !== undefined &&
    !Array.isArray(r["artifact_reconciliation"])
  ) {
    errors.push("artifact_reconciliation must be an array when provided");
  }
  if (Array.isArray(r["artifact_reconciliation"])) {
    const allowed = new Set<ArtifactReconciliationDecision>([
      "polaris-only",
      "summary-only",
      "both",
      "no-change",
    ]);
    for (const [index, update] of r["artifact_reconciliation"].entries()) {
      if (typeof update !== "object" || update === null) {
        errors.push(`artifact_reconciliation[${index}] must be an object`);
        continue;
      }
      const entry = update as Record<string, unknown>;
      if (typeof entry["folder"] !== "string" || !entry["folder"]) {
        errors.push(`artifact_reconciliation[${index}].folder must be a non-empty string`);
      }
      if (
        typeof entry["decision"] !== "string" ||
        !allowed.has(entry["decision"] as ArtifactReconciliationDecision)
      ) {
        errors.push(
          `artifact_reconciliation[${index}].decision must be one of: polaris-only, summary-only, both, no-change`,
        );
      }
      if (typeof entry["polaris_md"] !== "string" || !entry["polaris_md"]) {
        errors.push(
          `artifact_reconciliation[${index}].polaris_md must be a non-empty string`,
        );
      }
      if (entry["summary_md"] !== null && typeof entry["summary_md"] !== "string") {
        errors.push(
          `artifact_reconciliation[${index}].summary_md must be a string or null`,
        );
      }
      if (typeof entry["reason"] !== "string" || !entry["reason"]) {
        errors.push(`artifact_reconciliation[${index}].reason must be a non-empty string`);
      }
    }
  }
  if (!Array.isArray(r["docs_ingested"])) {
    errors.push("docs_ingested must be an array");
  }
  if (!Array.isArray(r["docs_archived"])) {
    errors.push("docs_archived must be an array");
  }
  if (!Array.isArray(r["yaml_updates"])) {
    errors.push("yaml_updates must be an array");
  }
  if (!Array.isArray(r["cognition_archived"])) {
    errors.push("cognition_archived must be an array");
  }
  if (typeof r["link_validation"] !== "object" || r["link_validation"] === null) {
    errors.push("link_validation must be an object");
  }
  if (!Array.isArray(r["blockers"])) {
    errors.push("blockers must be an array");
  }
  if (typeof r["reconciled_at"] !== "string") {
    errors.push("reconciled_at must be a string");
  }
  if (typeof r["evidence_summary"] !== "string") {
    errors.push("evidence_summary must be a string");
  }

  return errors;
}

/**
 * Determine whether a CloseoutLibrarianResult allows the Foreman to proceed to finalize.
 * Returns null if finalize may proceed; returns a blocker description string if not.
 */
export function checkLibrarianResultGate(result: CloseoutLibrarianResult): string | null {
  if (result.status === "success" || result.status === "partial") {
    return null;
  }
  if (result.status === "blocked") {
    const blocking = result.blockers.filter((b) => b.resolution_required);
    if (blocking.length === 0) {
      throw new Error("Invalid result: status 'blocked' but no resolution_required blockers");
    }
    const desc = blocking.map((b) => b.description).join("; ");
    return `Closeout Librarian blocked: ${desc}`;
  }
  return `Closeout Librarian failed: ${result.evidence_summary}`;
}
