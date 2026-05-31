/**
 * Foreman-side cognition-librarian dispatch and patch validation.
 *
 * dispatchCognitionLibrarian — groups pending work notes by folder, dispatches
 * a cognition-librarian session per folder, waits for the sealed result, and
 * calls validateAndApplyLibrarianResult on each.
 *
 * validateAndApplyLibrarianResult — enforces the 5 validation rules from spec
 * §6 and writes approved patches to disk.
 *
 * Spec: smartdocs/specs/active/folder-cognition-staging-librarian.md §6
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionAdapter } from "../loop/adapters/types.js";
import { hasDoctrineBled, isSummaryOversized } from "./summary-delta.js";
import {
  validateCognitionLibrarianResult,
  type CognitionLibrarianPacket,
  type CognitionLibrarianResult,
  type CognitionPatch,
  type ValidationOutcome,
} from "./librarian-types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

export interface DispatchCognitionLibrarianOptions {
  runId: string;
  clusterId: string;
  /** Repo-relative paths to pending work note files (from CompactReturn work_note_paths). */
  workNotePaths: string[];
  repoRoot: string;
  adapter: ExecutionAdapter;
  provider: string;
  telemetryFile: string;
  /** Milliseconds to wait for the result file after dispatch. Default: 120 000. */
  timeoutMs?: number;
  dryRun?: boolean;
}

export interface FolderDispatchOutcome {
  folder: string;
  folder_slug: string;
  outcome: ValidationOutcome | null;
  error?: string;
}

export interface DispatchCognitionLibrarianResult {
  /** Number of librarian sessions dispatched (not counting skipped folders). */
  dispatched: number;
  outcomes: FolderDispatchOutcome[];
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Extract key–value pairs from a YAML frontmatter block. */
function parseNoteFrontmatter(content: string): Record<string, string> | null {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  if (!match?.[1]) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip surrounding matching quotes and unescape common escaped sequences
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      // Unescape common escaped sequences
      value = value.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }

    if (key) result[key] = value;
  }
  return result;
}

function appendTelemetry(
  telemetryFile: string,
  event: Record<string, unknown>,
): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}

/** Poll until result file appears or timeout expires. */
async function waitForResultFile(
  resultPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (existsSync(resultPath)) return true;
    await new Promise<void>((res) => setTimeout(res, POLL_INTERVAL_MS));
  } while (Date.now() < deadline);
  return existsSync(resultPath);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Dispatch a cognition-librarian session for each folder that has pending work
 * notes with docs_impact ≠ "none". Non-blocking to cluster execution — a
 * librarian failure does not halt the cluster.
 */
export async function dispatchCognitionLibrarian(
  options: DispatchCognitionLibrarianOptions,
): Promise<DispatchCognitionLibrarianResult> {
  const {
    runId,
    clusterId,
    workNotePaths,
    repoRoot,
    adapter,
    provider,
    telemetryFile,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    dryRun = false,
  } = options;

  // Group note paths by folder slug, skipping notes that need no doc update.
  type NoteGroup = { folder: string; folder_slug: string; note_paths: string[] };
  const groups = new Map<string, NoteGroup>();

  for (const notePath of workNotePaths) {
    const absPath = resolve(repoRoot, notePath);
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }
    const meta = parseNoteFrontmatter(content);
    if (!meta) continue;

    const folderSlug = meta["folder_slug"] ?? "";
    const folder = meta["folder"] ?? "";
    const docsImpact = meta["docs_impact"] ?? "none";

    if (!folderSlug || docsImpact === "none") continue;

    if (!groups.has(folderSlug)) {
      groups.set(folderSlug, { folder, folder_slug: folderSlug, note_paths: [] });
    }
    groups.get(folderSlug)!.note_paths.push(notePath);
  }

  if (groups.size === 0) {
    return { dispatched: 0, outcomes: [] };
  }

  const outcomes: FolderDispatchOutcome[] = [];
  let dispatched = 0;

  for (const group of groups.values()) {
    const dispatchId = randomUUID();
    const cognitionDir = join(repoRoot, ".polaris", "cognition");
    const packetPath = join(cognitionDir, "packets", `${dispatchId}.json`);
    const resultPath = join(cognitionDir, "results", `${dispatchId}.json`);

    const polarisMdPath = join(group.folder, "POLARIS.md");
    const summaryMdAbsPath = join(repoRoot, group.folder, "SUMMARY.md");
    const summaryMdPath = existsSync(summaryMdAbsPath)
      ? join(group.folder, "SUMMARY.md")
      : null;
    const cognitionIndexPath = join(
      ".polaris",
      "cognition",
      "archive",
      group.folder_slug,
      "cognition-index.json",
    );

    const allowedFiles = [polarisMdPath];
    if (summaryMdPath) allowedFiles.push(summaryMdPath);

    const packet: CognitionLibrarianPacket = {
      run_id: runId,
      dispatch_id: dispatchId,
      role: "cognition-librarian",
      folder: group.folder,
      folder_slug: group.folder_slug,
      note_paths: group.note_paths,
      polaris_md_path: polarisMdPath,
      summary_md_path: summaryMdPath,
      cognition_index_path: cognitionIndexPath,
      result_path: resultPath,
      constraints: {
        max_polaris_addition_lines: 20,
        max_summary_addition_lines: 30,
        require_confidence_threshold: 0.80,
        allowed_files: allowedFiles,
      },
    };

    if (!dryRun) {
      mkdirSync(dirname(packetPath), { recursive: true });
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(packetPath, JSON.stringify(packet, null, 2), "utf-8");

      appendTelemetry(telemetryFile, {
        event: "cognition-librarian-dispatched",
        run_id: runId,
        cluster_id: clusterId,
        dispatch_id: dispatchId,
        folder: group.folder,
        folder_slug: group.folder_slug,
        note_count: group.note_paths.length,
        packet_path: packetPath,
        result_path: resultPath,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      await adapter.dispatch(
        {
          schema_version: "2.1",
          run_id: runId,
          cluster_id: clusterId,
          active_child: `cognition-librarian:${group.folder_slug}`,
          state_file: packetPath,
          telemetry_file: telemetryFile,
          dispatch_id: dispatchId,
          context: {
            role: "cognition-librarian",
            cognition_librarian_packet_path: packetPath,
          },
        },
        { provider, dryRun },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "cognition-librarian-patch-rejected",
          run_id: runId,
          dispatch_id: dispatchId,
          folder: group.folder,
          folder_slug: group.folder_slug,
          reason: "dispatch-error",
          error: msg,
          timestamp: new Date().toISOString(),
        });
      }
      outcomes.push({
        folder: group.folder,
        folder_slug: group.folder_slug,
        outcome: null,
        error: msg,
      });
      continue;
    }

    dispatched += 1;

    if (dryRun) {
      outcomes.push({ folder: group.folder, folder_slug: group.folder_slug, outcome: null });
      continue;
    }

    // Wait for result file — dispatch should have written it, poll as safety net.
    const resultExists = await waitForResultFile(resultPath, timeoutMs);
    if (!resultExists) {
      const errMsg = `Cognition librarian result not found at ${resultPath} after ${timeoutMs}ms`;
      appendTelemetry(telemetryFile, {
        event: "cognition-librarian-patch-rejected",
        run_id: runId,
        dispatch_id: dispatchId,
        folder: group.folder,
        folder_slug: group.folder_slug,
        reason: "result-timeout",
        timestamp: new Date().toISOString(),
      });
      outcomes.push({
        folder: group.folder,
        folder_slug: group.folder_slug,
        outcome: null,
        error: errMsg,
      });
      continue;
    }

    let result: CognitionLibrarianResult;
    try {
      result = JSON.parse(readFileSync(resultPath, "utf-8")) as CognitionLibrarianResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcomes.push({
        folder: group.folder,
        folder_slug: group.folder_slug,
        outcome: null,
        error: `Failed to parse librarian result: ${msg}`,
      });
      continue;
    }

    appendTelemetry(telemetryFile, {
      event: "cognition-librarian-result-received",
      run_id: runId,
      dispatch_id: dispatchId,
      folder: group.folder,
      folder_slug: group.folder_slug,
      status: result.status,
      confidence: result.confidence,
      notes_reconciled_count: result.notes_reconciled?.length ?? 0,
      timestamp: new Date().toISOString(),
    });

    let outcome: ValidationOutcome;
    try {
      outcome = validateAndApplyLibrarianResult(result, repoRoot, packet);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTelemetry(telemetryFile, {
        event: "cognition-librarian-patch-rejected",
        run_id: runId,
        dispatch_id: dispatchId,
        folder: group.folder,
        folder_slug: group.folder_slug,
        reason: "validation-error",
        error: msg,
        timestamp: new Date().toISOString(),
      });
      outcomes.push({
        folder: group.folder,
        folder_slug: group.folder_slug,
        outcome: null,
        error: `Validation failed: ${msg}`,
      });
      continue;
    }

    if (outcome.approved) {
      appendTelemetry(telemetryFile, {
        event: "cognition-librarian-patch-applied",
        run_id: runId,
        dispatch_id: dispatchId,
        folder: group.folder,
        folder_slug: group.folder_slug,
        files_written: outcome.files_written,
        patches_applied_count: outcome.patches_applied.length,
        timestamp: new Date().toISOString(),
      });
    } else {
      appendTelemetry(telemetryFile, {
        event: "cognition-librarian-patch-rejected",
        run_id: runId,
        dispatch_id: dispatchId,
        folder: group.folder,
        folder_slug: group.folder_slug,
        reason: outcome.rejection_reason,
        timestamp: new Date().toISOString(),
      });
    }

    outcomes.push({ folder: group.folder, folder_slug: group.folder_slug, outcome });
  }

  return { dispatched, outcomes };
}

/**
 * Validate a cognition-librarian result against all 5 foreman safety rules
 * (spec §6) and write approved patches to disk.
 *
 * Rules that reject the ENTIRE result (approved: false, no writes):
 *   - Invalid schema
 *   - Confidence below packet threshold (§6.4)
 *   - Any patch targets a file outside allowed_files (§6.1)
 *
 * Rules that reject a SPECIFIC PATCH only (other patches still applied):
 *   - SUMMARY.md patch contains doctrine bleed patterns (§6.2)
 *   - Proposed content exceeds size constraints (§6.3)
 */
export function validateAndApplyLibrarianResult(
  result: CognitionLibrarianResult,
  repoRoot: string,
  packet: CognitionLibrarianPacket,
): ValidationOutcome {
  // Rule: Schema validation — reject entire result on failure.
  const schemaErrors = validateCognitionLibrarianResult(result);
  if (schemaErrors.length > 0) {
    return {
      approved: false,
      rejection_reason: `SCHEMA_INVALID: ${schemaErrors.join("; ")}`,
      files_written: [],
      patches_applied: [],
      patches_rejected: [],
    };
  }

  // Rule §6.4: Confidence threshold — reject entire result if below threshold.
  if (result.confidence < packet.constraints.require_confidence_threshold) {
    return {
      approved: false,
      rejection_reason: `COGNITION_LOW_CONFIDENCE: confidence ${result.confidence} below threshold ${packet.constraints.require_confidence_threshold}`,
      files_written: [],
      patches_applied: [],
      patches_rejected: [],
    };
  }

  // Rule §6.1: File scope check — reject entire result if any patch targets an out-of-scope file.
  for (const patch of result.proposed_patches) {
    if (!packet.constraints.allowed_files.includes(patch.file)) {
      return {
        approved: false,
        rejection_reason: `COGNITION_SCOPE_VIOLATION: file "${patch.file}" not in allowed_files`,
        files_written: [],
        patches_applied: [],
        patches_rejected: result.proposed_patches.map((p) => ({
          patch: p,
          reason: "result rejected due to scope violation",
        })),
      };
    }
  }

  // No patches proposed — approved as no-change, notes can be archived.
  if (result.proposed_patches.length === 0) {
    return {
      approved: true,
      files_written: [],
      patches_applied: [],
      patches_rejected: [],
    };
  }

  // Per-patch checks (doctrine bleed §6.2 and size guard §6.3).
  // These reject the individual patch and continue applying the rest.
  const patchesApplied: CognitionPatch[] = [];
  const patchesRejected: Array<{ patch: CognitionPatch; reason: string }> = [];
  const filesWritten: string[] = [];

  for (const patch of result.proposed_patches) {
    const isSummaryPatch = patch.file === packet.summary_md_path;
    const isPolarisPath = patch.file === packet.polaris_md_path;

    // Rule §6.2: Doctrine bleed — SUMMARY.md must not contain operational imperatives.
    if (isSummaryPatch && hasDoctrineBled(patch.proposed_content)) {
      patchesRejected.push({
        patch,
        reason: "COGNITION_DOCTRINE_BLEED: SUMMARY.md patch contains operational doctrine patterns",
      });
      continue;
    }

    // Rule §6.3: Size guard.
    if (isPolarisPath) {
      const absPath = resolve(repoRoot, patch.file);
      let currentLines = 0;
      try {
        const currentContent = readFileSync(absPath, "utf-8");
        currentLines = currentContent.split("\n").length;
      } catch {
        // File doesn't exist yet, treat as 0 lines
        currentLines = 0;
      }
      const proposedLines = patch.proposed_content.split("\n").length;
      const netNew = Math.max(0, proposedLines - currentLines);
      if (netNew > packet.constraints.max_polaris_addition_lines) {
        patchesRejected.push({
          patch,
          reason: `COGNITION_SIZE_GUARD: POLARIS.md net-new ${netNew} lines exceeds max ${packet.constraints.max_polaris_addition_lines}`,
        });
        continue;
      }
    } else if (isSummaryPatch && isSummaryOversized(patch.proposed_content)) {
      patchesRejected.push({
        patch,
        reason: "COGNITION_SIZE_GUARD: SUMMARY.md patch exceeds SUMMARY_MAX_BYTES",
      });
      continue;
    }

    // All checks passed — write proposed content.
    const absPath = resolve(repoRoot, patch.file);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, patch.proposed_content, "utf-8");
    filesWritten.push(patch.file);
    patchesApplied.push(patch);
  }

  // approved = true when at least one patch was applied, or when there were no
  // rejections (all patches passed — even if empty after early-return guard).
  const approved = patchesApplied.length > 0 || patchesRejected.length === 0;

  return {
    approved,
    ...(patchesApplied.length === 0 && patchesRejected.length > 0
      ? { rejection_reason: "all patches rejected" }
      : {}),
    files_written: filesWritten,
    patches_applied: patchesApplied,
    patches_rejected: patchesRejected,
  };
}
