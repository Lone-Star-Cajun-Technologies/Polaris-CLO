/**
 * Types and schema validator for the cognition-librarian role.
 *
 * The librarian is dispatched by the foreman after a worker completes. It
 * reconciles staged work notes into durable folder cognition (POLARIS.md /
 * SUMMARY.md) and returns a sealed proposed patch — it never writes directly.
 *
 * Spec: smartdocs/specs/active/folder-cognition-staging-librarian.md §3
 */

export interface CognitionConstraints {
  /** Maximum net new lines allowed in a proposed POLARIS.md patch. Default: 20. */
  max_polaris_addition_lines: number;
  /** Maximum net new lines allowed in a proposed SUMMARY.md patch. Default: 30. */
  max_summary_addition_lines: number;
  /** Minimum confidence score required to apply patches (0.0–1.0). Default: 0.80. */
  require_confidence_threshold: number;
  /** Repo-relative paths the librarian is permitted to propose changes for. */
  allowed_files: string[];
}

export interface CognitionLibrarianPacket {
  run_id: string;
  dispatch_id: string;
  role: "cognition-librarian";
  /** Repo-relative path of the folder being reconciled (e.g. "src/loop/"). */
  folder: string;
  /** Slug derived from folder path (e.g. "src-loop"). */
  folder_slug: string;
  /** Repo-relative paths to pending work notes to reconcile. */
  note_paths: string[];
  /** Repo-relative path to the folder's current POLARIS.md. */
  polaris_md_path: string;
  /** Repo-relative path to the folder's current SUMMARY.md, or null if absent. */
  summary_md_path: string | null;
  /** Repo-relative path to the archive cognition-index.json for this folder. */
  cognition_index_path: string;
  /** Absolute path where the librarian must write its sealed result JSON. */
  result_path: string;
  constraints: CognitionConstraints;
}

export interface CognitionPatch {
  /** Repo-relative path of the file to update. Must be in packet.constraints.allowed_files. */
  file: string;
  action: "update" | "create";
  /** Full proposed file content (not a diff). */
  proposed_content: string;
  /** ≤50-word summary of what changed. */
  change_summary: string;
}

export interface ArchiveAction {
  /** Source path in .polaris/cognition/pending/. */
  note_path: string;
  /** Destination path in .polaris/cognition/archive/. */
  archive_path: string;
}

export interface CognitionLibrarianResult {
  run_id: string;
  dispatch_id: string;
  role: "cognition-librarian";
  folder: string;
  folder_slug: string;
  /** Paths to notes that were read and reconciled. */
  notes_reconciled: string[];
  /** Librarian confidence score (0.0–1.0). */
  confidence: number;
  proposed_patches: CognitionPatch[];
  archive_actions: ArchiveAction[];
  status: "success" | "no-change" | "low-confidence" | "failure";
  failure_reason?: string;
}

export interface ValidationOutcome {
  /**
   * True when the result was processed: patches applied (possibly partial) or
   * no patches needed. False when the entire result was rejected and pending
   * notes must remain in place.
   */
  approved: boolean;
  /** Reason for full rejection (set only when approved is false). */
  rejection_reason?: string;
  /** Repo-relative paths of files written during this validation cycle. */
  files_written: string[];
  patches_applied: CognitionPatch[];
  patches_rejected: Array<{ patch: CognitionPatch; reason: string }>;
}

/**
 * Validate an unknown value against the CognitionLibrarianResult schema.
 * Returns an array of error strings; empty means valid.
 */
export function validateCognitionLibrarianResult(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["CognitionLibrarianResult must be a JSON object"];
  }
  const r = value as Record<string, unknown>;

  if (r["role"] !== "cognition-librarian") {
    errors.push('role must be "cognition-librarian"');
  }
  if (typeof r["run_id"] !== "string" || !r["run_id"]) {
    errors.push("missing or empty run_id");
  }
  if (typeof r["dispatch_id"] !== "string" || !r["dispatch_id"]) {
    errors.push("missing or empty dispatch_id");
  }
  if (typeof r["folder"] !== "string") {
    errors.push("folder must be a string");
  }
  if (typeof r["folder_slug"] !== "string") {
    errors.push("folder_slug must be a string");
  }
  if (!Array.isArray(r["notes_reconciled"])) {
    errors.push("notes_reconciled must be an array");
  }
  if (
    typeof r["confidence"] !== "number" ||
    r["confidence"] < 0 ||
    r["confidence"] > 1
  ) {
    errors.push("confidence must be a number between 0.0 and 1.0");
  }
  if (!Array.isArray(r["proposed_patches"])) {
    errors.push("proposed_patches must be an array");
  }
  if (!Array.isArray(r["archive_actions"])) {
    errors.push("archive_actions must be an array");
  }

  const validStatuses = ["success", "no-change", "low-confidence", "failure"];
  if (!validStatuses.includes(r["status"] as string)) {
    errors.push(`status must be one of: ${validStatuses.join(", ")}`);
  }

  return errors;
}
