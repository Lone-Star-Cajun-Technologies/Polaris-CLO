---
name: polaris-medic-step-02
description: Analyze the failure, identify root cause, and determine repair strategy.
---

# Step 02 — Diagnose

## Purpose

Analyze the failure event to understand what went wrong and determine a repair strategy. This step does not make any changes to the codebase.

## Actions

### 2.1 Analyze Error Message

Examine the error message from the failed result packet:
- What type of error occurred?
- Which file or component is implicated?
- Is this a syntax error, runtime error, validation error, or test failure?

### 2.2 Examine Changed Files

Review the files that were changed by the failed worker:
- Do the changes introduce syntax errors?
- Do the changes break existing functionality?
- Are there missing dependencies or imports?
- Are there type mismatches?

### 2.3 Identify Root Cause

Based on the error analysis and file examination, identify the root cause:

Common root causes:
- Syntax error in introduced code
- Missing or incorrect dependency
- Type mismatch or type error
- Logic error in implementation
- Test failure due to incorrect expectations
- Configuration error
- Environment mismatch

### 2.4 Determine Repair Strategy

Based on the root cause, determine the appropriate repair strategy:

Repair strategies:
- Fix syntax errors
- Add missing dependencies
- Correct type annotations
- Adjust logic implementation
- Update test expectations
- Fix configuration
- Document environment requirements

If the root cause is unclear or the repair strategy is uncertain, record this as a blocker and proceed with best-effort repair or defer treatment.

### 2.5 Record Diagnosis

Record the diagnosis internally (not written to disk):

```yaml
diagnosis:
  root_cause: <identified root cause>
  repair_strategy: <chosen repair strategy>
  uncertainty: <any doubts or blockers>
  deferred: <true if treatment deferred>
```

### 2.6 Emit Telemetry

Emit `medic-step-complete` event for step 02 (if telemetry path provided).

## Completion Criteria

- Error analyzed
- Root cause identified (or uncertainty recorded)
- Repair strategy determined (or deferred)

Proceed to step 03.