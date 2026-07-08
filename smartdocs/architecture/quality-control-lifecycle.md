---
kind: architecture
status: active
source: POL-471
cluster: POL-470
created: 2026-07-07
updated: 2026-07-08
implements:
related: smartdocs/specs/active/quality-control-architecture.md,smartdocs/raw/analysis/pol-461-quality-control-analysis.md,smartdocs/raw/analysis/pol-500-provider-agnostic-qc-repair-loop-analysis.md,src/qc/POLARIS.md,src/finalize/POLARIS.md,src/loop/POLARIS.md,src/cluster-state/POLARIS.md,src/autoresearch/POLARIS.md
supersedes:
superseded_by:
depends_on:
validates:
source_paths: src/qc/,src/finalize/,src/loop/,src/cluster-state/,src/autoresearch/
ingest-run-id: polaris-run-pol-470-2026-07-07-001
classified-as: architecture
---

# Quality Control Lifecycle and Operational Boundaries

**Status:** Authoritative architecture note  
**Issue:** POL-471  
**Cluster:** POL-470  
**Created:** 2026-07-07

---

## Purpose

This document describes how Quality Control (QC) fits into the Polaris cluster lifecycle, what operational boundaries it must respect, and how the runtime routes QC findings without letting an external provider override Polaris-owned decisions.

---

## Lifecycle placement

QC is an external critic that runs after Polaris-owned evidence exists. The preferred placement is:

1. **After all children complete** — worker commits, result packets, and telemetry are durable.
2. **After Closeout Librarian runs** — documentation and cognition evidence are stable.
3. **Before or after PR creation** — depending on provider mode.
   - `completed-cluster` trigger: QC reviews local branch diff/history before PR creation.
   - `pr` trigger: QC reviews the open PR after `polaris finalize` creates it.

Child-level QC is an exception. It runs after a single child completes and before the next child is dispatched, but only when the route or child is explicitly marked high-risk or the operator requests it.

---

## Operational boundaries

| Boundary | Polaris owner | QC provider role |
|---|---|---|
| Validation pass/fail | Worker and `src/loop/finalize-evidence.ts` | May observe, must not override. |
| Commit/artifact promotion | `src/finalize/artifact-policy.ts` | May comment on, must not change. |
| PR creation / push / tracker closeout | `src/finalize/` | Review target only. |
| Severity policy and delivery blocking | Polaris QC policy | Provider supplies severity labels; Polaris applies policy. |
| Attribution to children | Polaris attribution resolver | Provider supplies location metadata. |
| Auto-fix eligibility | Polaris auto-fix policy | Provider supplies fix suggestions. |
| Repair routing | Polaris router/repair dispatcher | Provider suggests categories. |
| SOL scoring | `src/autoresearch/` | Provider findings are normalized inputs. |

---

## Trigger timing

| Trigger | Timing | Default |
|---|---|---|
| `completed-cluster` | After Closeout Librarian, before finalize opens PR. | Default for local-capable providers. |
| `pr` | After `polaris finalize` opens the PR. | Default for PR-only providers. |
| `child` | After one child completes, before next dispatch. | High-risk or explicit-policy only. |

PR-level and completed-cluster-level QC are the default. Child-level QC is gated to avoid cost, noise, and disruption.

---

## Artifact storage

QC results live at:

```text
.polaris/clusters/<cluster-id>/qc/<qc-run-id>.json
```

Raw provider output is retained when safe:

```text
.polaris/clusters/<cluster-id>/qc/<qc-run-id>-raw.<json|txt|md>
```

These paths are durable Polaris artifacts. They may be promoted into a finalize commit by `artifact-policy.ts` rules, but they never leave the repo as scratch output.

---

## Provider neutrality

CodeRabbit is the feasibility-first candidate, but no provider is mandatory. The adapter layer maps each provider's output into the normalized Polaris finding schema. Adding a new provider does not change the severity, attribution, auto-fix, or routing models.

---

## Repair routing flow

After normalization and policy application:

1. `critical`/`high` findings block delivery or escalate to operator review.
2. `medium` findings route to the original worker when attribution is high/medium confidence, or to a repair worker when attribution is low.
3. `low`/`info` findings create follow-up issues or are logged only, per policy.
4. Auto-fixes are applied only for low/medium findings that pass all eligibility gates and validation.

---

## SOL feedback

QC findings enter SOL scoring as advisory signals. The SOL pipeline:

- Normalizes provider severity and confidence.
- Weights findings by attribution confidence.
- Aggregates patterns across providers to avoid noise.
- Proposes human review or follow-up analysis, never a unilateral block.

---

## Bounded repair-round lifecycle placement

The repair loop runs as a bounded sub-lifecycle within the QC lifecycle. It is placed after `qc_results_normalized` and before `qc_passed` or a terminal escalation outcome.

```text
QC trigger fires (completed-cluster or pr)
        │
        ▼
Provider(s) invoked — all attempts produce telemetry
        │  (fallback chain if primary fails)
        ▼
Provider output parsed → normalized QcFinding array
        │
        ▼
Policy applied: severity, attribution, auto-fix eligibility
        │
        ▼
Auto-fix applied for eligible findings (opt-in, validated)
        │
        ▼
Repair packet manifest compiled
 (.polaris/clusters/<id>/qc/repair-rounds/<round>/repair-packets.json)
        │
        ▼
Repair workers dispatched via Worker Router (worker_role: repair)
  ┌─────┤  Parallel-safe packets may run concurrently (§8.8)
  │     ▼
  │  Repair workers return results
  │     │
  │     ▼
  │  Post-repair QC rerun (back to "Provider(s) invoked")
  │     │
  └─────┤  if round < maxRepairRounds AND unresolved findings remain
        │
        ▼
Terminal outcome reached (§8.7):
  - qc_passed           → delivery proceeds
  - follow-up / log     → delivery proceeds with tracker follow-up
  - operator_review     → loop suspends; operator resolves
  - max_rounds_reached  → escalate medium+ to operator review
  - medic_referral      → loop suspends; Medic dispatched
  - all_providers_failed → apply failurePolicy per provider
```

**Max repair rounds:** `2` by default. Override via `polaris.config.json → qc.maxRepairRounds`.

**Foreman discovery:** Repair packets become governed dispatch children when the repair round starts. Foreman discovers them from the compiled manifest and uses the Worker Router to dispatch repair workers as it would any other governed child.

**Loop invariant:** The repair loop is a sub-lifecycle of QC, not a replacement for the outer cluster lifecycle. `open_children` and `completed_children` in `current-state.json` are managed by the parent runtime; the repair loop manages round state in cluster-state and QC artifacts only.

---

## Related documents

- `smartdocs/specs/active/quality-control-architecture.md` — full spec with provider, trigger, severity, attribution, auto-fix, repair loop contract, and SOL definitions.
- `smartdocs/raw/analysis/pol-461-quality-control-analysis.md` — source analysis for POL-461/POL-471.
- `smartdocs/raw/analysis/pol-500-provider-agnostic-qc-repair-loop-analysis.md` — source analysis for POL-500/POL-501 repair loop.
- `src/qc/POLARIS.md` — QC subsystem operational guidance.
- `src/finalize/POLARIS.md` — finalize operational guidance.
- `src/loop/POLARIS.md` — loop operational guidance.
- `src/cluster-state/POLARIS.md` — cluster-state operational guidance.
- `src/autoresearch/POLARIS.md` — autoresearch operational guidance.
