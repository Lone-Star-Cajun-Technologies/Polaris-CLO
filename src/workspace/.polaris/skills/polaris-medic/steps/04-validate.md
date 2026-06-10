---
name: polaris-medic-step-04
description: Verify that the repair resolves the failure.
---

# Step 04 — Validate

## Purpose

Verify that the repair changes successfully resolve the original failure. This step runs validation to confirm the fix works.

## Actions

### 4.1 Run Validation Commands

Run the validation commands specified in the failed result packet or cluster context:

Common validation commands:
- `npm run build` — verify TypeScript compilation
- `npm test` — verify test suite passes
- Specific test commands for the affected route

If no validation commands are specified, run:
- `npm run build`
- `npm test`

### 4.2 Analyze Validation Results

Examine the validation output:
- Did the build succeed?
- Did the tests pass?
- Are there any remaining errors related to the original failure?

### 4.3 Determine Validation Outcome

Based on the validation results, determine the outcome:

- **Success**: All validation passes, original failure resolved
- **Partial**: Some validation passes, but issues remain
- **Failure**: Validation still fails, repair unsuccessful

If validation fails, record this as a blocker. The Medic may proceed to chart creation to document the partial treatment.

### 4.4 Record Validation Result

Record the validation result internally (not written to disk):

```yaml
validation_result:
  outcome: <success | partial | failure>
  build_passed: <true | false>
  tests_passed: <true | false>
  remaining_errors: [<any remaining errors>]
```

### 4.5 Emit Telemetry

Emit `medic-step-complete` event for step 04 (if telemetry path provided).

## Completion Criteria

- Validation commands executed
- Validation outcome determined
- Result recorded

Proceed to step 05.