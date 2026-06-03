---
name: closeout-librarian-chain
description: Step-order execution map for the Closeout Librarian. Runs once per completed cluster.
---

# Closeout Librarian Chain

## Authority

**The packet is authoritative. Do not infer cluster scope from conversation context.**

Read the packet before any analysis. Execute steps in strict order.

## Scope Contract

The Closeout Librarian operates on documentation and cognition only.

**Allowed writes:** POLARIS.md, SUMMARY.md (affected folders), smartdocs ingestion targets,
cognition archive, YAML frontmatter in doc files, sealed result JSON, librarian commit.

**Prohibited writes:** Source code, runtime state files, telemetry JSONL, cluster plan,
Linear issue status, PR creation.

---

## Step Traversal Order

```text
01-load-cluster-context       ← Read packet, load cluster evidence, build work inventory
02-reconcile-polaris-md       ← Update affected POLARIS.md files to reflect current reality
03-reconcile-summary-md       ← Refresh SUMMARY.md as continuation artifact
04-doc-ingestion              ← Ingest/promote/archive documentation from completed work
05-link-validation            ← Validate and repair broken links across affected docs
06-yaml-linking               ← Update YAML references for ingested/promoted documents
07-librarian-commit           ← Commit all documentation changes as sealed librarian commit
08-sealed-result              ← Write CloseoutLibrarianResult JSON to result_path, terminate
```

All steps must complete in order. Termination after step 08 is mandatory.

---

## Execution Rules

### Step Gate Behavior

- Each step must complete before the next begins.
- If a step encounters a recoverable error (e.g., one broken link that cannot be repaired),
  record the blocker and continue.
- If a step encounters a fatal error (e.g., packet unreadable, commit fails), record
  `status: "failure"` in the result and proceed to step 08 (sealed result write).
- Do not skip to step 08 for recoverable errors — complete the remaining steps.

### Write Discipline

Before writing any file, verify it is in `packet.allowed_write_paths`.
If the target file is in `packet.prohibited_write_paths`, skip and record as blocker.

### Commit Timing

All writes occur during steps 02–06. No writes occur during step 07 or after.
Step 07 creates exactly one git commit containing all documentation changes from this session.
If no documentation changed (all steps found everything current), step 07 makes no commit.
The result records `commit_sha: null` in this case — do not create an empty commit.

### Result Timing

Step 08 writes the sealed result JSON and terminates. No further writes are permitted after
the sealed result is written.

---

## Narration Rules

The Closeout Librarian does NOT produce user-facing narration during normal execution.

**Allowed output:**
- The sealed result JSON written to `result_path` (step 08)
- Escalation output if blocked on a decision that requires operator input

**Prohibited output:**
- Step-by-step progress narration
- Summary of what was found
- Interim status updates

All communication with the Foreman occurs through the sealed result and the commit record.

---

## Telemetry Events

Emit the following structured events to the telemetry file (if path provided in packet):

| Event | Step | Fields |
|---|---|---|
| `librarian-start` | 01 | `run_id`, `cluster_id`, `dispatch_id`, `timestamp` |
| `librarian-step-complete` | each step | `step`, `run_id`, `timestamp`, `outcome` |
| `librarian-commit` | 07 | `commit_sha`, `files_changed`, `timestamp` |
| `librarian-complete` | 08 | `status`, `run_id`, `timestamp` |

If no telemetry file is specified in the packet, skip telemetry events silently.

---

## Failure Handling

| Condition | Action |
|---|---|
| Packet unreadable | Write failure result to `result_path` if possible, otherwise stderr. Terminate. |
| Packet schema invalid | Write failure result, terminate |
| POLARIS.md has unresolvable conflict | Record blocker, skip that file, continue |
| Commit fails | Status: failure, record commit error, proceed to step 08 |
| Result write fails | Stderr only. Cannot recover. |
| All blockers, no writes | Status: `"blocked"`, list blockers, commit nothing |
| Some work done, some blocked | Status: `"partial"`, describe both |
