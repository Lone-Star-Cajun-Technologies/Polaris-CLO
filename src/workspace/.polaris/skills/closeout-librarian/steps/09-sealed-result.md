---
name: closeout-librarian-step-09
description: Write the sealed CloseoutLibrarianResult JSON to result_path and terminate.
---

# Step 09 — Sealed Result

## Purpose

The Librarian's sole communication channel with the Foreman is the sealed result JSON.
This step assembles the result from all prior steps and writes it to `packet.result_path`.

After writing the result, the Librarian session terminates. No further writes are permitted.

## Result Schema

```typescript
interface CloseoutLibrarianResult {
  schema_version: "1.0";
  role: "closeout-librarian";
  run_id: string;
  dispatch_id: string;
  cluster_id: string;
  status: "success" | "partial" | "blocked" | "failure";
  commit_sha: string | null;
  commit_message: string;
  files_committed: string[];  // repo-relative paths (e.g., "src/cli/POLARIS.md")
  drift_reconciliation: DriftReconciliationResult;
  polaris_md_updates: FileUpdate[];
  summary_md_updates: FileUpdate[];
  docs_ingested: DocAction[];
  docs_archived: DocAction[];
  yaml_updates: FileUpdate[];
  cognition_archived: CognitionArchiveEntry[];
  link_validation: LinkValidationReport;
  blockers: LibrarianBlocker[];
  reconciled_at: string;       // ISO8601
  evidence_summary: string;    // ≤200 words
}
```

## Status Determination

| Condition | Status |
|---|---|
| Commit succeeded, no blockers | `"success"` |
| Commit succeeded, informational blockers only | `"success"` |
| Commit succeeded, some work could not be done (recoverable blockers) | `"partial"` |
| No changes needed (everything already current) | `"success"` (commit_sha: null) |
| Some work attempted but blocked before commit | `"blocked"` |
| Commit failed | `"failure"` |
| Packet unreadable or invalid | `"failure"` |

## Evidence Summary

The `evidence_summary` field must be ≤200 words. It should describe:
- What was reconciled (POLARIS.md updated, docs ingested, etc.)
- What was left as-is (already current)
- Any blockers that require operator attention
- What a future session needs to know

Write it for a human operator or Foreman, not for a technical log.

## Foreman Validation (Foreman Reads This)

The Foreman validates the result before proceeding to `polaris finalize`:
1. `status` must be `"success"` or `"partial"` to proceed.
2. `"blocked"` or `"failure"` halts finalize and escalates to the operator.
3. `commit_sha` (if non-null) must be reachable in the current git log.
4. `files_committed` must not include any path from `prohibited_write_paths`.

## Actions

### 9.1 Assemble Result

Collect from all prior steps:
- `drift_reconciliation` (step 02)
- `polaris_md_updates` (step 03)
- `summary_md_updates` (step 04)
- `docs_ingested`, `docs_archived`, `cognition_archived` (step 05)
- `link_validation` (step 06)
- `yaml_updates` (step 07)
- `commit_sha`, `files_committed` (step 08)
- Blockers accumulated across all steps

### 9.2 Determine Status

Apply the status determination matrix above.

### 9.3 Write Evidence Summary

Write a ≤200-word plain-text summary of what the Librarian did and what remains.

### 9.4 Write Result File

Write the assembled JSON to `packet.result_path`.

Verify the write succeeded (file exists and is valid JSON after write).

### 9.5 Emit Telemetry

Emit `librarian-complete` event with `status` and `run_id`.

### 9.6 Terminate

The Closeout Librarian session ends here. No further output, no further writes.

---

## Failure Recovery (Result Write Fails)

If `packet.result_path` cannot be written:
1. Write a minimal failure result to stderr:
   ```text
   CLOSEOUT_LIBRARIAN_RESULT_WRITE_FAILED: run_id=<run_id> dispatch_id=<dispatch_id> status=failure
   ```
2. The Foreman must detect this condition and escalate to the operator.
3. Do not attempt to write the result to a different path.
