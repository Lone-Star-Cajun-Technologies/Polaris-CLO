---
name: polaris-run-step-08-closeout-librarian
description: Dispatch the Closeout Librarian exactly once after cluster-complete. PR creation is blocked until the Librarian result is validated.
---

# Step 08 — Closeout Librarian

## Purpose

The Closeout Librarian reconciles completed cluster work into project cognition and documentation.
It runs exactly once per cluster, after all children complete and before PR creation.

PR creation MUST NOT occur until this step succeeds.

## Preconditions

- All children in this cluster are confirmed Done.
- The cluster state is `cluster-complete`.
- The delivery branch is clean (no uncommitted worker changes).

If any precondition fails: stop and report. Do not proceed.

## Librarian Dispatch Model

The Closeout Librarian is dispatched as a bounded session, separate from worker sessions.
The Foreman:
1. Generates the Librarian packet.
2. Dispatches the Librarian as a subagent (same dispatch model as workers).
3. Waits for the Librarian to write its sealed result JSON.
4. Validates the result before proceeding to step 09.

The Foreman does NOT:
- Read the Librarian's session transcript.
- Observe the Librarian's execution in detail.
- Repair the Librarian's output manually.
- Skip this step because the Librarian appears slow.

## Actions

### 8.1 Generate Librarian Packet

Run:
```bash
npm run polaris -- librarian packet <cluster-id>
```

This generates a `CloseoutLibrarianPacket` at:
`.polaris/clusters/<cluster-id>/librarian-packet-<dispatch-id>.json`

The packet includes:
- All completed child IDs, commit SHAs, changed files
- All affected folder POLARIS.md and SUMMARY.md paths
- All pending cognition note paths
- SmartDocs raw paths for ingestion consideration
- Run report path
- Result path: `.polaris/clusters/<cluster-id>/librarian-result-<dispatch-id>.json`
- Prohibited and allowed write paths

If packet generation fails: stop and report. Do not dispatch.

### 8.2 Dispatch Librarian Session

Dispatch the Librarian as a bounded subagent session:
```text
Packet path: .polaris/clusters/<cluster-id>/librarian-packet-<dispatch-id>.json
Role: closeout-librarian
Skill: .polaris/skills/closeout-librarian/SKILL.md
```

The Librarian session prompt must contain ONLY the packet path. Do not add implementation
instructions or context. The packet is the complete and authoritative instruction source.

Dispatch boundary enforcement:
- The Foreman does not inline the Librarian's work.
- The Foreman waits for the sealed result file to appear at the packet's `result_path`.
- The Foreman does not read the Librarian's transcript.

### 8.3 Wait for Sealed Result

Wait for the Librarian to write the sealed result JSON to `packet.result_path`.

Timeout: 10 minutes (600 seconds). If timeout exceeded:
1. Record blocker: `librarian-timeout`
2. Escalate to operator with options:
   - Re-dispatch Librarian
   - Halt run

### 8.4 Validate Librarian Result

Read the sealed result JSON from `packet.result_path`.

Validate:
1. `result.role` must be `"closeout-librarian"`
2. `result.run_id` must match the active run
3. `result.dispatch_id` must match the dispatch
4. `result.status` must be `"success"` or `"partial"` to proceed
5. If `result.commit_sha` is non-null: verify the commit is in the current git log
6. `result.files_committed` must not contain any path from `prohibited_write_paths`

### 8.5 Decision

| Result Status | Action |
|---|---|
| `"success"` | Proceed to step 09 |
| `"partial"` | Proceed to step 09; record partial result in run state |
| `"blocked"` | Halt; escalate to operator with blocker descriptions |
| `"failure"` | Halt; escalate to operator with failure details |
| Result file missing | Halt; escalate: librarian did not produce output |

### 8.6 Record Librarian Result in State

Update run state with the Librarian dispatch record:
```json
{
  "librarian_dispatch_id": "<dispatch-id>",
  "librarian_commit": "<commit_sha or null>",
  "librarian_status": "<status>",
  "librarian_completed_at": "<ISO timestamp>"
}
```

## Scope Declarations

```yaml
allowed_files:
  - .polaris/clusters/<cluster-id>/librarian-packet-*.json
  - .polaris/clusters/<cluster-id>/librarian-result-*.json
  - .taskchain_artifacts/polaris-run/current-state.json
allowed_routes:
  - .polaris/skills/closeout-librarian/SKILL.md
  - .polaris/skills/closeout-librarian/chain.md
expected_evidence:
  - librarian packet generated
  - librarian session dispatched
  - sealed result written and validated
  - librarian result recorded in run state
stop_rules:
  - preconditions not met
  - packet generation fails
  - librarian result status is "blocked" or "failure"
  - result validation fails
```

## Next Step

Proceed to step 09 (final delivery) only when librarian result status is `"success"` or `"partial"`.
