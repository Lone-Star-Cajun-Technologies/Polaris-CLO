---
name: polaris-medic-chain
description: Step-order execution map for the Medic role. Dispatched when worker execution fails.
---

# Medic Chain

## Authority

**The packet is authoritative. Do not infer cluster scope or conversation context.**

Read the packet before any analysis. Execute steps in strict order.

## Scope Contract

The Medic operates on implementation repair and chart creation only.

**Allowed writes:** Implementation code (repair only), `smartdocs/medic/charts/` (chart creation), sealed result JSON, medic commit.

**Prohibited writes:** Runtime state files, telemetry JSONL, cluster plan, issue tracker status, POLARIS.md, SUMMARY.md (Librarian responsibility).

---

## Step Traversal Order

```text
01-orient-medic       ← Read packet, load failed result, build diagnosis inventory
02-diagnose           ← Analyze failure, identify root cause, determine repair strategy
03-repair             ← Execute repair changes to implementation code
04-validate           ← Verify repair resolves the failure
05-create-chart       ← Create medical chart documenting the failure and treatment
06-closeout           ← Commit repair changes, write sealed result, terminate
```

All steps must complete in order. Termination after step 06 is mandatory.

---

## Execution Rules

### Step Gate Behavior

- Each step must complete before the next begins.
- If a step encounters a recoverable error (e.g., diagnosis uncertain), record the blocker and continue with best-effort repair.
- If a step encounters a fatal error (e.g., packet unreadable, commit fails), record `status: "failure"` in the result and proceed to step 06 (sealed result write).
- Do not skip to step 06 for recoverable errors — complete the remaining steps.

### Write Discipline

Before writing any file, verify it is in `packet.allowed_write_paths`.
If the target file is in `packet.prohibited_write_paths`, skip and record as blocker.

### Commit Timing

All repair writes occur during step 03. Chart creation occurs during step 05.
Step 06 creates exactly one git commit containing all changes from this session.
If no repair or chart was created (e.g., diagnosis deferred), step 06 makes no commit.
The result records `commit_sha: null` in this case — do not create an empty commit.

### Result Timing

Step 06 writes the sealed result JSON and terminates. No further writes are permitted after the sealed result is written.

---

## Narration Rules

The Medic does NOT produce user-facing narration during normal execution.

**Allowed output:**
- The sealed result JSON written to `result_path` (step 06)
- Escalation output if blocked on a decision that requires operator input

**Prohibited output:**
- Step-by-step progress narration
- Summary of diagnosis or repair
- Interim status updates

All communication with the Foreman occurs through the sealed result and the commit record.

---

## Telemetry Events

Emit the following structured events to the telemetry file (if path provided in packet):

| Event | Step | Fields |
|---|---|---|
| `medic-start` | 01 | `run_id`, `cluster_id`, `dispatch_id`, `timestamp` |
| `medic-step-complete` | each step | `step`, `run_id`, `timestamp`, `outcome` |
| `medic-commit` | 06 | `commit_sha`, `files_changed`, `timestamp` |
| `medic-complete` | 06 | `status`, `run_id`, `timestamp` |

If no telemetry file is specified in the packet, skip telemetry events silently.

---

## Failure Handling

| Condition | Action |
|---|---|
| Packet unreadable | Write failure result to `result_path` if possible, otherwise stderr. Terminate. |
| Packet schema invalid | Write failure result, terminate |
| Diagnosis uncertain | Record blocker, proceed to repair with best-effort or deferred treatment |
| Repair fails | Status: failure, record repair error, proceed to step 06 |
| Validation fails | Status: partial, record validation failure, proceed to chart creation |
| Chart creation fails | Status: partial, record chart error, proceed to step 06 |
| Commit fails | Status: failure, record commit error, proceed to step 06 |
| Result write fails | Stderr only. Cannot recover. |
| All blockers, no writes | Status: `"blocked"`, list blockers, commit nothing |
| Some work done, some blocked | Status: `"partial"`, describe both |