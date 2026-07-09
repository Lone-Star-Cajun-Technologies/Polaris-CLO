# SOL Run-Health Threshold Integration

**SmartDoc ID:** sol-run-health-thresholds  
**Status:** Active  
**Scope:** `src/autoresearch/sol-run-health-bridge.ts`, `src/config/schema.ts` (`SolThresholdsConfig`)  
**Related:** POL-515, POL-522, POL-509

---

## Overview

SOL (Self-Optimization Loop) scores runs on multiple dimensions. By default these scores are
**advisory only** — they surface insights but do not create run-health reports or block finalize.

This document explains when and how SOL scores trigger run-health symptoms and Medic consultation
requirements, how operators tune the thresholds, and how to bypass them when needed.

---

## Threshold Defaults

| Threshold | Config key | Default | Description |
|-----------|-----------|---------|-------------|
| Low composite score | `low_composite_score` | `0.4` | Fires when the run composite score < threshold |
| QC repair-loop failure | `qc_repair_loop_failure_statuses` | `["max-rounds", "medic-referral", "all-providers-failed"]` | Fires when the QC repair loop reaches any listed terminal status |
| Repeated provider failures | `repeated_provider_failures` | `3` | Fires when ≥ N workers score 0.0 composite (provider consistently fails) |
| Foreman intervention count | `foreman_intervention_count` | `2` | Fires when escalation events exceed the threshold |
| Stale / wrong-run telemetry | `stale_wrong_run_telemetry` | `true` | Fires when redispatch count ≥ provider-failure threshold OR dispatch epoch overhead ≥ 3 |
| Validation failures | `validation_failures` | `2` | Fires when ≥ N workers have validation score = 0 |

---

## Advisory by Default

SOL threshold evaluation is **disabled** unless the operator explicitly enables it:

```json
{
  "sol": {
    "thresholds": {
      "enabled": false
    }
  }
}
```

With `enabled: false` (the default when `sol.thresholds` is absent), the bridge detects
crossings internally but writes nothing. No run-health report is created.

---

## Activating Run-Health Report Creation

To have SOL append symptoms to the run-health report when thresholds fire:

```json
{
  "sol": {
    "thresholds": {
      "enabled": true,
      "policy": {
        "createRunHealthReport": true
      }
    }
  }
}
```

SOL-created symptoms carry `source_actor.role = "sol"` and reference the SOL score snapshot
as evidence. They do **not** mutate raw metric artifacts.

---

## Requiring Medic Consultation

To have SOL automatically set the `medic_consult.status = "pending"` flag when critical
thresholds fire (which will block finalize until Medic decides):

```json
{
  "sol": {
    "thresholds": {
      "enabled": true,
      "policy": {
        "createRunHealthReport": true,
        "requireMedic": true
      }
    }
  }
}
```

With `requireMedic: true`, finalize step 5.11 (the Medic gate) will block until Medic
records either `resolved` or `bypassed` on the run-health report.

---

## Custom Thresholds

Override individual thresholds to tune sensitivity:

```json
{
  "sol": {
    "thresholds": {
      "enabled": true,
      "policy": { "createRunHealthReport": true },
      "low_composite_score": 0.3,
      "repeated_provider_failures": 2,
      "foreman_intervention_count": 1,
      "qc_repair_loop_failure_statuses": ["medic-referral"],
      "stale_wrong_run_telemetry": false,
      "validation_failures": 3
    }
  }
}
```

---

## Bypassing the Medic Gate

If SOL created a run-health report and finalize is blocked, an operator can:

1. **Record Medic decision** — use `polaris medic decide` (or manually write to the report)
   with status `resolved` or `bypassed`.
2. **CLI bypass** — if `finalize.medic.bypassPolicy = "cli"` is set, pass
   `--bypass-medic "<reason>"` to `polaris finalize`.

---

## Evidence Integrity

SOL-created symptoms:
- Reference the SOL score snapshot path as `evidence_refs` entries.
- Do **not** modify QC artifacts, telemetry files, or any other raw metric artifact.
- Are tagged `source_actor.role = "sol"` so Medic can distinguish them from worker or
  Foreman-originated symptoms.

---

## POL-509 Regression Pattern

The following score signals indicate a POL-509-like run:

| Signal | Description |
|--------|-------------|
| `run_composite_score < 0.4` | Run health significantly degraded |
| `qc_repair_loop.score = 0` with `status=medic-referral` | QC repair loop terminated with Medic referral |
| `dispatch_epoch >> continue_epoch + 1` | Wrong-run telemetry (budget exhausted in prior attempt) |
| ≥ 3 workers with `composite_score = 0` | Repeated provider failures across workers |
| `escalation_events > 2` | Foreman intervened repeatedly |

When these patterns appear together and `sol.thresholds.enabled = true`, SOL will append
multiple symptoms and (with `requireMedic: true`) prevent finalize from creating a PR until
Medic reviews the run.
