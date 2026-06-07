---
name: closeout-librarian-step-02
description: Run formal drift reconciliation checklist to detect and record repository memory drift.
---

# Step 02 — Drift Reconciliation

## Purpose

Implementation complete does not equal run complete. After every completed run, the Librarian
must perform a formal drift reconciliation to ensure repository memory accurately reflects
the current state of the route.

This step detects and records drift observations. It does not resolve drift inline —
resolution is a separate task if needed.

## Drift Observation Types

The following drift observation types are recognized:

| Type | Description |
|---|---|
| `summary_outdated` | SUMMARY.md no longer describes current reality |
| `canon_mismatch` | POLARIS.md does not match actual route structure or behavior |
| `route_guidance_outdated` | Worker guidance or constraints in POLARIS.md are stale |
| `missing_documentation` | Required documentation is absent for changed code |
| `invalid_reference` | Links or canonical references point to non-existent or moved content |

## Checklist

Run this checklist in order. For each item, assess whether drift exists and record observations.

### 2.1 Review Worker Results

Review the work inventory from step 01:

1. Examine `work_inventory.all_changed_files` — what code actually changed
2. Review child summaries for behavioral changes, dependency changes, or architectural shifts
3. Compare actual changes against existing POLARIS.md and SUMMARY.md descriptions

**Questions:**
- Did behavior change in a way not reflected in POLARIS.md?
- Did dependencies change (added, removed, updated)?
- Did architecture or responsibilities shift?
- Are there new capabilities not documented?

**If drift detected:** Record observation type (`canon_mismatch`, `route_guidance_outdated`, or `missing_documentation`).

### 2.2 Review Medic Results (if applicable)

If Medic ran in this cluster:

1. Read all Medic charts created in this run (from `packet.medic_chart_paths`)
2. Review drift observations recorded in chart metadata (`drift_observations` field)
3. Note any reusable knowledge revealed by the charts

**Questions:**
- Did Medic detect drift not visible from worker results alone?
- Did a chart reveal a pattern that should be captured in route cognition?
- Are there chart relationships that indicate recurring issues?

**If drift detected:** Medic already recorded observations in the chart. Librarian must address
these in subsequent reconciliation steps (03–04).

**If Medic did not run:** Skip this section.

### 2.3 Review POLARIS.md Accuracy

For each affected folder in `work_inventory.affected_folders`:

1. Read the current POLARIS.md content
2. Compare against the actual state of the folder after cluster changes
3. Verify: route purpose, responsibilities, architecture, constraints, guidance

**Questions:**
- Does POLARIS.md still describe the route accurately?
- Are there stale statements about removed capabilities?
- Are new capabilities or constraints missing?
- Is the architecture description current?

**If drift detected:** Record observation type (`canon_mismatch` or `route_guidance_outdated`).

### 2.4 Review SUMMARY.md Currency

For each affected folder with a SUMMARY.md:

1. Read the current SUMMARY.md content
2. Verify the Current State and Route Health sections reflect reality
3. Check if Recent Treatments needs updating

**Questions:**
- Does SUMMARY.md still describe the current state?
- Is the Route Health status accurate?
- Are there known issues or improvement opportunities not captured?

**If drift detected:** Record observation type (`summary_outdated`).

### 2.5 Review Canonical References

For each SUMMARY.md with a `canonical_docs` block:

1. Verify each referenced path exists
2. Confirm references are still relevant to the route
3. Check for missing important references

**Questions:**
- Do any canonical references point to non-existent files?
- Are there important docs missing from the canonical list?
- Are references still navigation-relevant or have they become obsolete?

**If drift detected:** Record observation type (`invalid_reference` or `missing_documentation`).

### 2.6 Chart Linking Requirement (when Medic ran)

If Medic ran in this cluster:

1. Identify all charts created in this run (from `packet.medic_chart_paths`)
2. For each chart, create a concise entry in the affected folder's SUMMARY.md under `## Recent Treatments`
3. Format: `CHART-YYYY-MM-DD-NNN — <brief one-line summary of treatment>`

**This is a required action when Medic ran.**

Example:
```markdown
## Recent Treatments

CHART-2026-06-04-001 — Worker result validation failure repaired and verified.
CHART-2026-06-05-003 — Chart schema validation failure fixed and regression test added.
```

**If Medic did not run:** Skip this section.

## Output

Build the following internal structure for use in subsequent steps:

```yaml
drift_reconciliation:
  medic_ran: <true|false>
  charts_created: [<chart_ids>]
  drift_observations: [
    { type: "<observation_type>", target: "<file or description>", severity: "<low|medium|high>" },
    ...
  ]
  chart_links_required: <true if Medic ran>
  charts_linked: [<chart_ids linked in SUMMARY.md>]
```

This structure is passed to steps 03–04 for reconciliation action.

## Completion Criteria

- All checklist items completed
- Drift observations recorded (if any)
- Chart linking requirement acknowledged (if Medic ran)

Proceed to step 03.