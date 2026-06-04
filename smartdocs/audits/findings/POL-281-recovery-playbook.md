---
source: smartdocs/audits/findings/POL-281-recovery-playbook.md
ingest-run-id: migrated
classified-as: audit-finding
linked-map-area: src/loop
ingested-at: 2026-06-04T06:15:00.000Z
status: raw
---

# POL-281 Recovery Notes

## Summary

POL-281 began as a stuck implementation cluster and ultimately became a full runtime recovery exercise. Multiple independent issues were discovered, fixed, tested, and merged.

Final outcome:

- Cluster completed successfully.
- All children completed with canonical evidence.
- Finalize completed and pushed to GitHub.
- Full test suite passed (1217/1217).
- Runtime state reconciled.

---

# Initial Symptoms

## Stuck Dispatch

Loop status showed:

- Active child set to POL-281
- Runtime state = packet-created
- No worker heartbeat
- No result file
- Dispatch boundary blocked

Repeated aborts did not clear the stale dispatch.

---

## Missing current-state.json

Runtime could not load:

```text
.taskchain_artifacts/polaris-run/current-state.json
```

State had been renamed to a stale backup variant.

Temporary recovery:

- Restore current-state.json from stale backup
- Re-establish runtime visibility

---

## Root Classification Failure

POL-281 was incorrectly appearing in:

```json
open_children
```

Result:

- Parent issue treated as runnable child
- Dispatch attempted against cluster root
- Loop state became inconsistent

Diagnosis:

```json
cluster_root = POL-281
children = [POL-280, POL-279, POL-278, POL-277]
```

Expected runnable children should exclude cluster_root.

Fix merged later through tracker sync and cluster classification improvements.

---

# Dispatch Recovery Findings

## Stale Dispatch Detection

Original stale dispatch logic relied on machine state.

Problem:

```text
status = blocked
```

caused early return before stale-dispatch evaluation.

Result:

- active_child remained dirty forever
- repeated aborts never recovered

Fix:

Stale dispatch detection now reads dispatch evidence directly:

- dispatch_record
- dispatch boundary
- heartbeat state
- result presence

instead of relying on status.

---

## Evidence Rules

Dispatch recovery now follows:

### Case 1

No heartbeat
No result file

Result:

```text
stale
clear active_child
```

### Case 2

Heartbeat exists

Result:

```text
preserve dispatch
worker may still be running
```

### Case 3

Result file exists

Result:

```text
preserve dispatch
worker completed
```

---

# Result File Contract Fix

Worker packets now always include:

```json
{
  "result_file_contract": {
    "result_file": "<path>"
  }
}
```

Changes:

- Contract made required
- Packet compilers always emit contract
- Dispatch path guarantees result path exists before packet generation
- Worker prompt always includes sealed result section

---

# Evidence Bridge Discovery

Major root cause discovered.

Worker result files existed:

```text
POL-277
POL-278
POL-279
POL-280
```

but cluster-state contained:

```json
commits: {}
validation_results: {}
result_pointers: {}
```

Finalize therefore had no canonical evidence.

---

## Evidence Bridge

Added bridge during loop continue.

Bridge writes:

```json
commits
validation_results
result_pointers
child_states
```

into cluster-state.

Purpose:

Convert worker result evidence into canonical cluster evidence.

---

# Historical Evidence Problem

Bridge fixed future runs.

POL-281 had completed before bridge existed.

Result:

- Existing evidence never migrated
- Finalize still failed

Solution:

Evidence backfill command.

Backfill reads:

```text
sealed result files
```

and reconstructs:

```json
commits
validation_results
result_pointers
```

inside cluster-state.

---

# POL-277 Placeholder Commit

Discovered result file:

```text
pending-single-commit
```

instead of real git hash.

Finalize correctly rejected:

```text
commit not found in git history
```

Recovery:

- rerun POL-277
- produce real commit
- backfill evidence

Final commit:

```text
ecce3e2052505fca00a9e4f26b2895317a433584
```

---

# Finalize Failure

Next blocker:

Finalize required staged source files.

Problem:

Polaris worker model stores implementation evidence in child commits.

Finalize assumed implementation evidence must exist in current working tree.

Mismatch:

```text
Worker model:
evidence = child commits

Finalize model:
evidence = staged files
```

Fix:

Finalize now accepts canonical child commit evidence from cluster-state.

Validation:

- child commits exist
- commit hashes valid
- validation passed
- commit contains non-artifact source changes

---

# Map Index Drift

Finalize later failed due to missing indexed files.

Deleted:

```text
bootstrap packet
temporary current-state backup
```

still existed in:

```text
.polaris/map/index.json
.polaris/map/needs-review.json
```

Manual cleanup performed.

Finding:

Map update detects missing files but does not prune stale entries.

Future fix needed.

---

# Main Branch PR Failure

Finalize completed successfully.

GitHub push succeeded.

Failure occurred during PR creation:

```text
main -> main
```

GitHub correctly rejected.

Finding:

Finalize should detect:

```text
head == base
```

and skip PR creation.

---

# Final POL-281 State

Loop status:

```text
status = cluster-complete
open_children = []
active_child = none
```

Canonical evidence:

```text
POL-277 complete
POL-278 complete
POL-279 complete
POL-280 complete
```

All children contain:

- commit
- validation
- result pointer
- child state

---

# Runtime Fixes Produced

1. Root classification repair
2. Stale dispatch recovery improvements
3. Result file contract enforcement
4. Evidence bridge during continue
5. Evidence backfill command
6. Placeholder commit rejection
7. Finalize child-evidence acceptance
8. Main-branch finalize support
9. Multiple new test suites

---

# Remaining Follow-Up Issues

1. Skip PR creation when head == base.
2. Map update should prune deleted files.
3. Remove finalize test harness path noise.
4. Improve completed-cluster bootstrap messaging.

---

# Key Lesson

The major architectural discovery from POL-281:

```text
Worker execution evidence
must become
canonical cluster evidence
before finalize.
```

This became the foundation for the evidence bridge and evidence backfill systems.
