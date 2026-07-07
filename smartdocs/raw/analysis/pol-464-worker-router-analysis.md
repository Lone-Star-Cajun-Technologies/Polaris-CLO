---
kind: analysis
status: raw
source: POL-464
created: 2026-07-07
related: smartdocs/raw/analysis/pol-460-worker-router-analysis.md,smartdocs/specs/active/worker-router-architecture.md
---

# POL-464 Worker Router Design Boundaries

**Status:** Raw analysis  
**Issue:** POL-464  
**Cluster:** POL-463  
**Created:** 2026-07-07

---

## Purpose

This document records the 9Router-informed design boundaries that were established before any runtime router code was written. It is the analysis counterpart to the authoritative `smartdocs/specs/active/worker-router-architecture.md` spec.

---

## 9Router-informed boundaries

### What Polaris keeps from 9Router

| 9Router idea | Polaris shape |
|---|---|
| Provider/model registry | `WorkerProviderRegistry` in config — keyed by provider name, with roles, capabilities, cost tier, and trust. |
| Quota and reset windows | `ProviderQuota` profile — manual config first, optional live introspection later. |
| Ordered fallback | Pre-dispatch provider fallback chain derived from `providerPolicy` and registry eligibility. |
| Request/dispatch logs | `router-decision-evidence`, `provider-selected`, `provider-fallback-attempted`, `provider-exhausted` telemetry events. |
| Cost-tier policy | `costTier` enum (`free`, `cheap`, `standard`, `premium`) used as a tie-breaker after eligibility and trust. |
| Usage analytics | SOL telemetry inputs for future autoresearch scoring. |

### What Polaris rejects from 9Router

| Rejected idea | Polaris boundary |
|---|---|
| LLM gateway as orchestrator | Foreman/parent still owns child selection, lifecycle, packet generation, and finalization. |
| External runtime dependency | No 9Router service call; all routing logic is Polaris-native. |
| Cost-only routing | Role policy, capability match, and child requirements take precedence over cost. |
| Post-start retry | Once a worker acknowledges or heartbeats, the provider is bound; no retry. |
| Dynamic child reordering | Child order comes from `open_children` and the cluster plan; the router does not reorder. |

---

## Polaris-owned vs router-owned boundaries

| Concern | Owner | Notes |
|---|---|---|
| Child ordering | Parent loop / Foreman | `open_children` order is authoritative. |
| Packet generation | Foreman | `WorkerPacket` is immutable after emission. |
| Lifecycle state machine | Foreman | `worker-lifecycle-state-machine.md` is canonical. |
| Provider selection | Worker Router | Returns a ranked candidate and fallback chain. |
| Slot/concurrency | Worker Router scheduler | Enforces `max_concurrent`; default is `1`. |
| Adapter execution | Execution adapter | `terminal-cli`, `agent-subtask`, future adapters. |
| Validation | Worker | Worker runs the validation commands in its packet. |
| Finalization | `src/finalize/` | Router does not touch delivery or PR creation. |
| Tracker reconciliation | `src/tracker/adapters/` | Tracker-agnostic per `AGENTS.md` / `CLAUDE.md`. |

---

## Responsibilities and non-responsibilities

### Router responsibilities

1. Compute provider eligibility from registry metadata, route/domain mapping, role policy, capability needs, and quota gates.
2. Produce deterministic provider ranking and fallback order with trust/cost as tie-breakers.
3. Coordinate slot leasing/release boundaries with scheduler state (`max_concurrent`).
4. Emit durable `router-decision-evidence` and fallback telemetry for SOL pipelines.

### Router non-responsibilities

1. Reordering children or bypassing `blockedBy` / cluster sequencing constraints.
2. Mutating `WorkerPacket` fields (scope, validation, role) after packet generation.
3. Owning lifecycle transitions, finalize delivery, or tracker synchronization.
4. Post-start provider switching after `worker-acknowledged` / heartbeat.

---

## Default behavior commitment

The default configuration must keep Polaris behaving exactly as it does today:

- `max_concurrent` defaults to `1`.
- Provider selection continues to use `execution.rotation`, `execution.providerPolicy`, or the first configured provider.
- `allowCrossAgentFallback` remains `false` by default.
- No external router service is contacted.

Multi-worker or policy-driven routing is strictly opt-in.

---

## Open risks recorded

- **Multi-worker changes parent-loop invariants.** It must be gated behind explicit config and a separate review before the default can change.
- **Quota data will be manual first.** Live provider introspection is a future enhancement; the router must not assume it.
- **Dynamic scheduling must respect existing contracts.** `blockedBy`, Linear hierarchy, allowed scope, and sealed result contracts remain hard constraints.
- **Trust/cost scores must be explainable before automated use.** They are advisory until a policy explicitly enables them.

---

## Recommended implementation order

1. Config and TypeScript types (POL-465).
2. Deterministic router decision engine (POL-466).
3. Slot-aware scheduling and worker pool state (POL-467).
4. Adapter fallback and quota signal integration (POL-468).
5. Router telemetry and SOL scoring inputs (POL-469).

This order preserves the single-worker default until the last responsible moment.
