---
kind: analysis
status: raw
source: POL-493
created: 2026-07-07
related: smartdocs/specs/active/worker-router-architecture.md,smartdocs/raw/analysis/pol-464-worker-router-analysis.md,smartdocs/raw/analysis/pol-484-sol-evaluation-reports-scorecards-analysis.md
---

# POL-493 Provider Routing Evidence Analysis

## Summary

POL-493 is executable as a small implementation cluster. The current runtime already has the Worker Router architecture and telemetry surfaces, but the evidence visible in recent run telemetry and closeout reports is not enough to explain why a multi-provider worker policy selected the same provider for every child.

The key implementation finding is compatibility mode. `resolveProviderAndMode` in `src/loop/dispatch.ts` bypasses `decideWorkerRoute()` when `execution.routerPolicy.providerRegistry` is empty. In that path, `providerPolicy.worker.providers` selects the first configured allowed provider and records `providersTried` as only that selected provider. The terminal adapter may still have enough policy to attempt fallback after pre-dispatch failure, but the run evidence does not show a full provider candidate set unless router evidence exists.

## Evidence

- `polaris.config.json` configures multiple worker providers under `execution.providerPolicy.worker.providers`, but no `execution.routerPolicy.providerRegistry`.
- `src/loop/dispatch.ts` treats missing provider registry as compatibility mode and calls legacy provider selection.
- `src/loop/router/engine.ts` supports deterministic candidate scoring with order, trust, cost, capability, quota, and slot evidence when registry metadata is present.
- `src/loop/dispatch-state.ts` defines provider-selected, provider-fallback-attempted, and provider-exhausted telemetry fields, including router candidates when available.
- `.taskchain_artifacts/polaris-run/runs/polaris-run-pol-470-2026-07-07-001/telemetry.jsonl` shows each child dispatched to `devin`, with `router_selection_reason`/`selected_slot_claim.selection_reason` set to `role-policy` or `policy-router`, and child completion events showing `providers_tried: ["devin"]`.
- `.polaris/runs/polaris-run-pol-470-2026-07-07-001/run-report.md` summarizes children and validation but not provider distribution, policy order, candidates, fallback, or missing registry evidence.
- `src/finalize/steps/12-archive.ts` archives state, run report, and map files, but not raw taskchain telemetry or a compact routing-evidence extract.
- `src/autoresearch/score.ts` summarizes router outcome telemetry, but current signals focus on selected/exhausted/fallback events and do not explicitly distinguish missing routing evidence, repeated same-provider selection, stale dispatch aborts, missing sealed results, or invalid inline attempts.

## Current Behavior

Role policy order is currently a provider preference/fallback order, not merely an eligibility set, when no rotation is configured. In compatibility mode — when `execution.routerPolicy.providerRegistry` is empty or missing — `resolveProviderAndMode` bypasses `decideWorkerRoute()` and the first configured provider allowed by `providerPolicy.<role>.providers` is selected. When `execution.rotation` is configured, the rotation list is filtered by the role policy and the first matching rotation provider wins. In router mode, candidate ranking uses registry metadata (order, trust, cost, capability, quota, and slots) after eligibility checks, and `providerPolicy.<role>.providers` acts as an eligibility filter.

Because compatibility mode does not call `decideWorkerRoute()`, the provider evidence shows only the selected provider in `providers_tried`. In router mode, the full ordered candidate list is returned as `providers_tried` and the adapter may try the next candidate on a pre-dispatch failure.

This means a recent run selecting the same provider for every child is explainable without assuming a routing bug: the repo was missing provider registry metadata, so dispatch used compatibility selection and recorded only the selected provider as tried. The problem is evidence quality, not necessarily selection behavior.

## Recommended Implementation Cluster

Create one IMPLEMENT parent under POL-493 with five ordered children:

1. Document current behavior and policy semantics.
2. Emit compact provider routing evidence for dispatch review.
3. Add routing evidence summaries to run reports and closeout.
4. Route provider routing anomalies to Medic and SOL review.
5. Define retention and archive rules for routing telemetry evidence.

## Risks

- Provider fallback evidence must distinguish pre-dispatch provider failure from worker execution failure.
- Missing registry metadata should be surfaced as a confidence/evidence gap, not treated as a failed run.
- Repeated same-provider selection is not inherently wrong; it should become a review signal only when policy evidence implies alternatives should have been considered.
- Retention changes must not commit `.taskchain_artifacts/**` wholesale.
- Routing recommendations must remain review-gated and must not silently mutate provider policy or trust scores.
