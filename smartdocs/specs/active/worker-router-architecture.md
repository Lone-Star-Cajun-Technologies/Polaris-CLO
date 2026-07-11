---
kind: spec
status: active
source: POL-464
created: 2026-07-07
implements:
related: smartdocs/raw/analysis/pol-460-worker-router-analysis.md,smartdocs/raw/analysis/pol-464-worker-router-analysis.md,smartdocs/specs/active/worker-lifecycle-state-machine.md,smartdocs/specs/active/worker-session-contract.md,smartdocs/specs/active/execution-adapters.md,smartdocs/specs/active/worker-telemetry-spec.md,smartdocs/specs/active/foreman-worker-architecture.md
supersedes:
superseded_by:
depends_on:
validates:
source_paths: src/loop/dispatch.ts,src/loop/dispatch-state.ts,src/loop/adapters/terminal-cli.ts,src/loop/adapters/registry.ts,src/config/schema.ts
ingest-run-id: polaris-run-pol-463-2026-07-07-001
classified-as: spec
---

# Worker Router Architecture and Invariants

**Status:** Authoritative architecture spec  
**Issue:** POL-464  
**Cluster:** POL-463  
**Created:** 2026-07-07

---

## Overview

This document defines the Polaris-native **Worker Router**: the component that decides which worker/provider should execute a given child, tracks concurrent execution slots, and records the evidence behind every routing decision. The design is informed by the 9Router provider-gateway concept, but Polaris keeps full ownership of orchestration, child ordering, packet generation, lifecycle state, and finalization.

The router is a **decision engine**, not a replacement for the Foreman or the parent loop. It is also not a runtime dependency on 9Router or any external LLM gateway. All routing logic is implemented inside Polaris and is fully optional: the default configuration preserves the existing single-worker-per-session behavior.

---

## 1. 9Router vs Polaris-owned boundaries

### 1.1 9Router concepts Polaris can adopt

9Router is best understood as a provider gateway. Its concepts that are useful for Polaris are:

| 9Router concept | Polaris adoption |
|---|---|
| Provider/model registry | Worker/provider registry with capability metadata |
| Quota and reset-window awareness | Quota gate (manual config first, optional live introspection later) |
| Ordered fallback tiers | Pre-dispatch provider fallback chain |
| Request/dispatch logging | Router decision telemetry (`provider-selected`, `provider-fallback-attempted`, etc.) |
| Cost-tier policy | Cost tier used as a tie-breaker after eligibility and trust |
| Multi-account round-robin/priority | Policy-driven ordering within the same role/route |

### 1.2 Concepts Polaris must reject

The following 9Router ideas must not enter the Polaris runtime:

| Rejected idea | Why |
|---|---|
| Replacing Polaris orchestration with an LLM gateway | Foreman/parent still owns child selection, lifecycle, and finalization. |
| Making 9Router a runtime dependency | Router is Polaris-native and has no external service dependency. |
| Routing solely by quota or cheapest provider | Issue scope, role authority, evidence, child ordering, and validation gates must remain intact. |
| Retrying a child on another provider after work has started | Once a worker has acknowledged or emitted a heartbeat, the child is bound to that worker; switching would double-dispatch. |
| Letting the router reorder or skip children | Child ordering is owned by the parent loop and the cluster plan. |

### 1.3 Ownership boundary

| Concern | Owner |
|---|---|
| Cluster decomposition and child ordering | Parent loop / Foreman |
| Packet generation and immutability | Foreman / `src/loop/worker-packet.ts` |
| Worker lifecycle state machine | Foreman / `src/loop/dispatch-state.ts` |
| Provider/model selection | Worker Router (this spec) |
| Slot/concurrency bookkeeping | Worker Router scheduler |
| Dispatch execution (spawn, CLI, subagent) | Execution adapter (`src/loop/adapters/`) |
| Validation and finalization gates | Worker and `src/finalize/` |
| Tracker reconciliation | `src/tracker/adapters/` |

---

## 2. Responsibilities and non-responsibilities

### 2.1 Router responsibilities

The Worker Router is responsible for:

1. Building an eligibility set from provider registry, role policy, route/domain hints, capability requirements, and quota state.
2. Ranking eligible providers using deterministic policy order with trust/cost tie-breakers.
3. Leasing and releasing dispatch slots via scheduler hooks (`max_concurrent` guard).
4. Emitting durable decision evidence and fallback telemetry for each dispatch attempt.
5. Performing pre-dispatch fallback when the adapter reports `pre_dispatch_failure`.

### 2.2 Router non-responsibilities

The Worker Router must not:

1. Reorder children, skip blocked children, or modify `open_children`.
2. Change packet content, allowed scope, validation commands, or child role authority.
3. Transition lifecycle states (`acked`, `heartbeat`, `completed`, `failed`, `blocked`) owned by Foreman state handlers.
4. Handle finalize delivery, tracker sync, PR updates, or canon promotion workflows.
5. Retry a child after work has started on a provider.

---

## 3. Core concepts

### 3.1 Worker/provider registry

The registry is a Polaris config surface that describes every provider the router can consider. It is separate from the command templates in `execution.providers`.

Registry entries include:

| Field | Purpose |
|---|---|
| `name` | Provider key (e.g., `codex`, `gemini`, `claude`, `windsurf`). |
| `adapter` | Adapter that materializes the provider (`terminal-cli`, `agent-subtask`). |
| `roles` | Which `ExecutionRole` values this provider may serve (default: `worker`). |
| `capabilities` | Flags such as `attachment`, `streaming`, `long_context`, `file_attachments`. |
| `model` | Default model identifier; used as a tie-breaker and for telemetry. |
| `costTier` | `free`, `cheap`, `standard`, `premium`. |
| `trust` | Configured initial trust score (0.0–1.0). |
| `quota` | Reference to a quota profile (see §3.6). |
| `enabled` | Whether the router may consider this provider. |

The registry is read-only at dispatch time. Runtime state (trust decay, quota consumption) is stored separately in the run state and telemetry.

### 3.2 Slot pool

A **slot** is the right to hold an active worker for one child. The slot pool enforces concurrency limits per run.

| Property | Default | Meaning |
|---|---|---|
| `max_concurrent` | `1` | Maximum active workers at the same time. |
| `slot_lease_id` | UUID | Correlates a child to a slot for the duration of the dispatch. |

- A slot is **leased** before the dispatch record is created.
- A slot is **released** when the child reaches a terminal state (`completed`, `failed`, `orphaned`) or when the dispatch fails before any worker starts (pre-dispatch failure).
- With `max_concurrent = 1`, the scheduler behaves exactly like the current single-worker loop.
- Multi-worker mode requires an explicit config change and is opt-in only.

### 3.3 Eligibility

A provider is **eligible** for a child only when all of the following hold:

1. The provider is `enabled` in the registry.
2. The provider's `roles` includes the child's resolved `ExecutionRole`.
3. The provider's `capabilities` satisfy any child-specific capability requirements (e.g., attachment required).
4. The provider is not policy-forbidden for the role (`providerPolicy.<role>.providers`).
5. The provider has not exhausted its quota for the current window.
6. The provider passes the adapter's probe (if the adapter implements `probe`).

Eligibility is a binary gate. A provider that is ineligible is recorded with a reason and is not scored.

### 3.4 Trust

**Trust** is a 0.0–1.0 score that reflects how reliably a provider has executed Polaris children in the past.

Inputs (advisory until explicitly enabled):

| Signal | Direction |
|---|---|
| Validation passed | Increases trust. |
| Compact return valid and on scope | Increases trust. |
| Out-of-scope block or approval timeout | Decreases trust. |
| Orphan or stale heartbeat | Decreases trust. |
| Operator override / manual retry | May reset or hold trust. |

Trust is used as a **tie-breaker** after eligibility, not as a routing override. A high-trust provider does not bypass role policy or child ordering.

### 3.5 Cost

**Cost** is a tiered signal:

| Tier | Use |
|---|---|
| `free` | No charge; preferred for low-risk or exploratory work only after eligibility. |
| `cheap` | Low-cost provider; useful for large batches. |
| `standard` | Default production tier. |
| `premium` | High-capability, high-cost; used when required by capability or policy. |

Cost is considered **after** eligibility and trust. The default policy is cost-agnostic: it selects the first eligible provider by policy order. A future policy may prefer cheaper tiers among equally trustworthy candidates.

### 3.6 Quota

A **quota** is a limit on provider usage in a time window.

| Field | Meaning |
|---|---|
| `requests_remaining` | Requests left in the current window. |
| `tokens_remaining` | Tokens left in the current window (if reported). |
| `resets_at` | ISO 8601 timestamp of the next quota reset. |
| `source` | `config` (static) or `provider` (live introspection). |

Quota data may initially be manual/configured. Live provider introspection is a future enhancement. A provider with `requests_remaining <= 0` is ineligible until reset.

### 3.7 Fallback

**Fallback** is only allowed before a worker has started. The router builds an ordered fallback list from the effective policy. If the adapter returns a `pre_dispatch_failure` (e.g., command not found, API error before the worker reads the packet), the router may try the next eligible provider.

Once a worker emits `worker-acknowledged` or `worker-heartbeat`, the child is bound to that provider. No further fallback is attempted for that dispatch event.

Delegated-mode fallback (`subagent` → `external-process` → `human-handoff`) remains unchanged and is separate from provider-level fallback.

### 3.8 Route / domain

A **route** maps a domain or child type to a role/policy. Routes are optional and are resolved after the child is selected but before the provider is chosen.

Examples:

| Route | Role | Policy hint |
|---|---|---|
| `docs/*` | `librarian` | Prefer providers with `long_context`. |
| `analyze/*` | `analyst` | Prefer providers with `file_attachments`. |
| `impl/*` | `worker` | Default worker policy. |

If no route matches, the child's default role is used. Routes do not override the cluster plan or child order.

### 3.9 SOL telemetry

Every routing decision emits structured telemetry events that can later be used as **SOL (Second-Order Learning)** inputs for autoresearch scoring.

| Event | Purpose |
|---|---|
| `provider-selected` | Records the chosen provider, adapter, selection reason, and decision evidence. |
| `provider-fallback-attempted` | Records why the router moved from one provider to another. |
| `provider-exhausted` | Records that no eligible provider could be selected. |
| `slot-leased` | Records that a child has claimed a concurrency slot. |
| `slot-released` | Records that a child has freed its slot. |
| `router-decision-evidence` | Carries the full eligibility list, excluded providers, trust/cost/quota scores, and policy rule. |

These events are durable, append-only, and queryable by `dispatch_id` and `run_id`.

---

## 4. Data flow

```text
Parent/Foreman requests dispatch for the next child
            │
            ▼
Scheduler: slot available?  ──no──►  return wait / pause
            │yes
            ▼
Child selector: next unblocked child from open_children
            │
            ▼
Router receives (child, role, route, registry, policy, quota, slot state)
            │
            ▼
Router builds eligibility list, applies trust/cost scores, picks top provider
            │
            ▼
Router writes decision evidence telemetry
            │
            ▼
Adapter factory creates adapter for selected provider
            │
            ▼
Adapter executes provider command and returns DispatchResult
            │
            ▼
If pre_dispatch_failure: try next eligible provider (fallback chain)
If worker started: no further fallback; child is bound
            │
            ▼
Foreman updates lifecycle state from worker telemetry
            │
            ▼
On terminal state: slot released; scheduler may dispatch next child
```

---

## 5. Router decision evidence

The router must produce a `RouterDecisionEvidence` record for every dispatch attempt. This record is the audit trail for SOL scoring.

### 5.1 Required evidence fields

| Field | Type | Description |
|---|---|---|
| `child_id` | `string` | Child being dispatched. |
| `role` | `ExecutionRole` | Resolved role for the child. |
| `route` | `string \| null` | Matched route, if any. |
| `policy_rule` | `string` | Which policy produced the ordered candidate list. |
| `candidates` | `Candidate[]` | Eligible providers with scores. |
| `excluded` | `ExcludedProvider[]` | Ineligible providers and reasons. |
| `selected_provider` | `string` | Winning provider. |
| `selected_adapter` | `string` | Adapter used. |
| `selection_reason` | `string` | Human-readable reason for the choice. |
| `fallback_chain` | `string[]` | Ordered providers to try on pre-dispatch failure. |

### 5.2 Candidate shape

```typescript
interface RouterCandidate {
  provider: string;
  adapter: string;
  eligible: boolean;
  role_match: boolean;
  capability_match: boolean;
  quota_available: boolean;
  policy_allowed: boolean;
  probe_ok: boolean;
  trust: number;
  cost_tier: "free" | "cheap" | "standard" | "premium";
  quota_remaining: number | null;
}
```

### 5.3 Telemetry mapping

The `router-decision-evidence` event is written to the same JSONL telemetry stream as worker heartbeats. The existing `provider-selected`, `provider-fallback-attempted`, and `provider-exhausted` events are populated from this evidence.

---

## 6. Scheduler boundaries

The scheduler owns only two things:

1. **Slot bookkeeping** — leasing and releasing concurrency slots.
2. **Dispatch readiness** — deciding whether a new child can be dispatched now.

The scheduler does **not**:

- Reorder `open_children`.
- Skip a child because it is blocked by another child or external dependency.
- Dispatch more children than `max_concurrent` allows.
- Change a child's role or allowed scope.
- Retry a child after a terminal state.

When `max_concurrent = 1`, the scheduler preserves the existing `one child per session` invariant. When multi-worker is enabled, it still respects `blockedBy`, tracker hierarchy, and sealed result contracts.

---

## 7. Migration stages

The router is built in incremental stages. Each stage defaults to single-worker behavior and keeps 9Router optional.

| Stage | Issue | Deliverable |
|---|---|---|
| 1 | POL-464 | Architecture spec and invariants (this document). |
| 2 | POL-465 | Config and TypeScript types for registry, slots, eligibility, trust, cost, quota, fallback, and routes. |
| 3 | POL-466 | Deterministic router decision engine with typed evidence. |
| 4 | POL-467 | Slot-aware child scheduling and worker pool state. |
| 5 | POL-468 | Router fallback integration with execution adapters and quota signals. |
| 6 | POL-469 | Router telemetry and SOL scoring inputs. |

No stage may change the default behavior to multi-worker. Multi-worker is opt-in via explicit configuration and a separate acceptance review.

---

## 8. Default behavior and invariants

### 8.1 Default behavior

When `execution.routerPolicy.providerRegistry` is empty or missing, Polaris dispatches in **compatibility mode**:

- `max_concurrent = 1`.
- Provider selection follows `execution.rotation`, then `execution.providerPolicy.<role>.providers`, then the first configured provider.
- `providerPolicy.<role>.providers` order is the provider preference/fallback order unless `execution.rotation` is configured, in which case the rotation is filtered by the policy and the first match wins.
- `allowCrossAgentFallback` remains `false` by default.
- One child is dispatched per `polaris loop continue` invocation.
- Only the selected provider appears in `providers_tried`, because the router engine is not engaged and no full candidate list is built.
- No external routing service is contacted.

### 8.2 Invariants

| Invariant | Description |
|---|---|
| **One active worker per child** | A child may have at most one active worker at any time. |
| **Foreman owns lifecycle** | The router selects providers; the Foreman transitions state. |
| **No dispatch without checkpoint** | A slot and a dispatch record are durably written before the adapter runs. |
| **Pre-dispatch fallback only** | Provider fallback is allowed only before the worker acknowledges the packet. |
| **Decision evidence is durable** | Every routing decision leaves a telemetry event. |
| **Quota/trust are advisory by default** | They do not override role policy or child ordering unless a policy explicitly says so. |
| **9Router is never a dependency** | The router is Polaris-native and has no required external service. |

### 8.3 Non-goals

- Do not implement runtime router code in this spec.
- Do not make 9Router a required dependency.
- Do not promote draft docs to doctrine without the existing SmartDocs promotion workflow.
- Do not change the default to multi-worker.

### 8.4 Compatibility mode vs router mode

**Compatibility mode** is active when `execution.routerPolicy.providerRegistry` is empty or missing. `resolveProviderAndMode` bypasses `decideWorkerRoute()` and uses legacy role-policy selection. The first configured provider allowed by `providerPolicy.<role>.providers` is selected, with `execution.rotation` taking precedence if it is configured. `providers_tried` contains only the selected provider because the router engine is not engaged and no full candidate list is built.

**Router mode** is active when `execution.routerPolicy.providerRegistry` contains provider metadata. `decideWorkerRoute()` builds an ordered candidate list from `execution.rotation` (or the configured provider order), filtered by `providerPolicy.<role>.providers` (which acts as an eligibility filter), then ranks each candidate by registry metadata (role, capability, trust, cost, quota, and slots). The ordered candidate list is returned as `providers_tried`, and the adapter may attempt the next candidate on a pre-dispatch failure.

---

## 9. Related documents

- `smartdocs/raw/analysis/pol-460-worker-router-analysis.md` — original 9Router analysis.
- `smartdocs/raw/analysis/pol-464-worker-router-analysis.md` — design boundaries recorded for this child.
- `smartdocs/specs/active/worker-lifecycle-state-machine.md` — canonical worker states.
- `smartdocs/specs/active/worker-session-contract.md` — session identity fields.
- `smartdocs/specs/active/execution-adapters.md` — adapter neutrality and fallback rules.
- `smartdocs/specs/active/worker-telemetry-spec.md` — telemetry event catalog.
- `smartdocs/specs/active/foreman-worker-architecture.md` — Foreman ownership and dispatch rules.
