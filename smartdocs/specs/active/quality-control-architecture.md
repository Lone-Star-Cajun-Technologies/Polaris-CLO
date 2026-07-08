---
kind: spec
status: active
source: POL-471
cluster: POL-470
created: 2026-07-07
updated: 2026-07-08
implements:
related: smartdocs/raw/analysis/pol-461-quality-control-analysis.md,smartdocs/raw/analysis/pol-500-provider-agnostic-qc-repair-loop-analysis.md,smartdocs/architecture/quality-control-lifecycle.md,smartdocs/specs/active/worker-router-architecture.md,smartdocs/specs/active/worker-lifecycle-state-machine.md,smartdocs/specs/active/worker-telemetry-spec.md,smartdocs/specs/active/polaris-artifact-promotion-commit-hygiene-policy.md
supersedes:
superseded_by:
depends_on:
validates:
source_paths: src/qc/,src/finalize/,src/loop/,src/cluster-state/,src/autoresearch/
ingest-run-id: polaris-run-pol-470-2026-07-07-001
classified-as: spec
---

# Quality Control Architecture and Lifecycle Boundaries

**Status:** Authoritative architecture spec  
**Issue:** POL-471  
**Cluster:** POL-470  
**Created:** 2026-07-07

---

## Overview

This document defines the Polaris-native **Quality Control (QC)** layer: a provider-agnostic external critic that reviews completed work after Polaris-owned validation evidence already exists. QC is not a replacement for Polaris validation, the Closeout Librarian, finalize evidence checks, or human PR review. It is an additional external signal that produces durable findings, attribution evidence, and repair-routing decisions that can feed future SOL/autoresearch scoring.

The default QC trigger is **PR-level or completed-cluster-level**. Child-level QC is reserved for configured high-risk routes, security-sensitive work, large diffs, repeated worker failures, or explicit operator request. No external QC provider is mandatory; Polaris ships with a CodeRabbit-first feasibility path and remains provider-neutral.

---

## 1. QC vs Polaris-owned boundaries

### 1.1 Concern ownership

| Concern | Owner |
|---|---|
| Child ordering and dispatch | Parent loop / Foreman |
| Worker validation commands and pass/fail | Worker and `src/loop/finalize-evidence.ts` |
| Commit hygiene and artifact promotion | `src/finalize/artifact-policy.ts` |
| PR creation, push, and tracker closeout | `src/finalize/` |
| Evidence of what changed and why | Worker commits, result packets, telemetry |
| External QC review, findings, and suggestions | QC provider (external critic) |
| Normalizing QC output into Polaris artifacts | `src/qc/` parser/adapter layer |
| Severity policy, attribution, auto-fix gating, repair routing | Polaris policy (`src/qc/policy.ts`) |
| SOL/autoresearch scoring inputs | `src/autoresearch/` |

### 1.2 What QC must not do

QC must not:

1. Replace Polaris validation gates or worker-owned validation commands.
2. Modify `open_children`, child ordering, or dispatch state.
3. Push commits, open PRs, or update tracker issues directly.
4. Apply auto-fixes without passing through Polaris auto-fix policy gates.
5. Override finalize evidence checks or the Closeout Librarian.
6. Become a hard dependency of any Polaris runtime path.

---

## 2. Provider responsibilities and non-responsibilities

### 2.1 Provider responsibilities

A QC provider is responsible for:

1. Reviewing a well-defined scope: a PR diff, a local branch diff/history, or an imported review payload.
2. Emitting structured findings with severity, location, category, and suggested action.
3. Making its raw output available to Polaris for parsing and durable storage.
4. Exposing any auto-fix or metrics capability through a documented API or CLI contract.

### 2.2 Provider non-responsibilities

A QC provider must not:

1. Decide whether a cluster is deliverable; that is Polaris finalize policy.
2. Route repairs to workers or open follow-up issues; that is Polaris routing policy.
3. Score workers or influence SOL directly; Polaris translates provider findings into normalized inputs.
4. Access tracker credentials or Polaris internal state beyond the provided review scope.

---

## 3. Trigger policy

### 3.1 Trigger levels

| Level | When it runs | Default |
|---|---|---|
| `pr` | After a PR is opened by `polaris finalize`. | **Default** when provider requires a PR URL. |
| `completed-cluster` | After all children are complete and Closeout Librarian has produced documentation evidence, but before finalize opens the PR. | **Default** when provider can review local diff/history. |
| `child` | After a single child completes and before the next child is dispatched. | **High-risk or explicit-policy only.** |

### 3.2 Default policy

PR-level and completed-cluster-level QC are the default. The operator or cluster policy may select one, both, or neither. Child-level QC is opt-in and policy-gated.

### 3.3 Child-level gating

Child-level QC may be enabled only when at least one of the following is true:

- The route is marked high-risk by `qc.routes.<route>.childLevel: true`.
- The child is security-sensitive, touches auth/data/migration logic, or has an explicit `qc: child` policy tag.
- The worker has repeated validation failures or prior QC findings in the same cluster.
- An operator explicitly requests child-level QC for the child.

Without one of these signals, child-level QC is skipped to avoid provider cost, review noise, and worker disruption.

---

## 4. Provider feasibility

### 4.1 CodeRabbit-first feasibility

CodeRabbit is the strongest first candidate:

- CLI and GitHub Action support local and PR review.
- Autofix can apply unresolved findings to the current PR branch or a stacked PR.
- Metrics API exposes PR review metadata such as comment counts by severity.

Polaris may integrate CodeRabbit first, but CodeRabbit is **not mandatory**. The adapter layer must support additional providers without changing the normalized finding schema.

### 4.2 Alternative providers

| Provider | Mode | Notes |
|---|---|---|
| PR-Agent / Qodo | `pr`, `local` | OSS CLI and GitHub Action; good fallback path. |
| GitHub Copilot code review | `pr` | GitHub-native, non-blocking advisory comments. |
| Sourcery | `pr` | Comment-driven PR review triggers. |
| Greptile | `pr` | Contextual reviewer with codebase understanding. |
| Custom metrics import | `metrics-import` | Import already-completed review payloads. |

### 4.3 Provider modes

| Mode | Description |
|---|---|
| `local` | Review local branch diff/history without a remote PR. |
| `pr` | Review an open PR URL. |
| `metrics-import` | Import normalized or provider-specific metrics/findings from another source. |

---

## 5. Core concepts

### 5.1 Severity

Findings use a normalized five-level severity scale:

| Severity | Default handling |
|---|---|
| `critical` | Block delivery or escalate to operator by default. |
| `high` | Block delivery by default unless explicitly waived. |
| `medium` | Route to repair unless policy allows passive follow-up. |
| `low` | Report or create follow-up only when configured. |
| `info` | Log only; never blocks delivery. |

Severity mapping from provider-specific labels is provider-configurable. A provider label that cannot be mapped lands in `info` with a `provider-uncertain` reason.

### 5.2 Artifacts

Each QC run produces a cluster-scoped artifact at:

```text
.polaris/clusters/<cluster-id>/qc/<qc-run-id>.json
```

Raw provider output is retained when safe and non-secret:

```text
.polaris/clusters/<cluster-id>/qc/<qc-run-id>-raw.<json|txt|md>
```

Normalized result fields:

| Field | Description |
|---|---|
| `schema_version` | QC result schema version. |
| `qc_run_id` | Unique QC run identifier. |
| `run_id` | Polaris run identifier. |
| `cluster_id` | Polaris cluster identifier. |
| `trigger` | `child`, `completed-cluster`, or `pr`. |
| `provider` | Provider name. |
| `provider_mode` | `local`, `pr`, or `metrics-import`. |
| `pr_url` | PR URL when `provider_mode: pr`. |
| `started_at` | ISO 8601 start timestamp. |
| `completed_at` | ISO 8601 end timestamp. |
| `status` | `passed`, `findings`, `blocked`, `failed`, or `skipped`. |
| `findings` | Array of normalized findings. |
| `raw_artifact_paths` | Paths to retained raw output. |
| `parser_version` | Parser version that produced the normalized result. |
| `policy_decision` | Aggregate severity decision and routing outcome. |

Finding fields:

| Field | Description |
|---|---|
| `finding_id` | Polaris-normalized finding identifier. |
| `provider_finding_id` | Provider's original finding identifier. |
| `severity` | `critical`, `high`, `medium`, `low`, or `info`. |
| `category` | Finding category, e.g., `style`, `security`, `bug`, `performance`, `architecture`. |
| `title` | Short finding title. |
| `message` | Detailed finding message. |
| `file` | Affected file path. |
| `range` | Line/column range when available. |
| `confidence` | Provider confidence when available. |
| `suggested_action` | Provider recommendation. |
| `fix_available` | Whether the provider produced a concrete fix. |
| `autofix_eligible` | Whether Polaris policy allows auto-applying this fix. |
| `attribution` | Attribution block (see §5.3). |
| `routing_decision` | Repair routing decision (see §5.5). |
| `status` | `open`, `autofixed`, `repaired`, `waived`, `follow-up`. |

### 5.3 Attribution

Attribution is evidence-based and confidence-scored:

| Confidence | Condition |
|---|---|
| `high` | Finding file/range maps to exactly one child commit and result packet. |
| `medium` | Finding maps to one child scope or changed file but line ownership is ambiguous. |
| `low` | Shared files, broad architecture findings, or provider-only metadata. |
| `unattributed` | No durable match against child commits or result packets. |

Attribution reason codes:

| Reason | Meaning |
|---|---|
| `commit-line-match` | Finding range matches a line introduced by a child commit. |
| `changed-file-owner` | File was changed by exactly one child in the cluster. |
| `child-scope-match` | Finding topic matches the child's documented scope. |
| `shared-file` | File was touched by multiple children or is cross-cutting. |
| `pre-existing` | Finding is in unchanged code or predates the cluster. |
| `provider-uncertain` | Provider did not give enough location metadata to attribute. |
| `unattributed` | No durable match found. |

Worker scoring must use severity and attribution confidence, not raw finding counts.

### 5.4 Auto-fix limits

Auto-fix is opt-in and conservative. It is allowed only when all of the following are true:

- Provider supports isolated fix output or stacked PR/current-branch fix mode.
- Severity is `low` or `medium` unless explicitly overridden by policy.
- Category is not `security`, `auth`, `data-loss`, `migration`, `architecture`, or `governance`.
- Branch is clean or the fix runs in a stacked PR path.
- Validation commands are known and runnable.
- Operator policy explicitly allows the mode for the provider and route.

Auto-fix is blocked when:

- Finding is `critical` or `high` by default.
- Provider confidence is low.
- Attribution is unknown and scope is broad.
- Fix would touch out-of-scope files.
- Prior auto-fix failed validation for this cluster.

Auto-fixes must pass Polaris validation before the finding is marked `autofixed`. A failed auto-fix reverts the change and leaves the finding `open` with a `autofix-failed` annotation.

### 5.5 Repair routing

Findings that remain open after severity and auto-fix policy are routed to one of:

| Target | Condition |
|---|---|
| Original worker | High/medium confidence attribution to a single child and the child is not yet closed. |
| Repair worker / Medic-style handoff | Cross-cutting, low-confidence attribution, or requires a specialist role. |
| Follow-up tracker issue | Low/info severity, pre-existing defects, or deferred work outside the cluster scope. |
| Operator review | Critical/high findings that block delivery or require policy waiver. |

Repair routing is a Polaris decision. The QC provider provides suggestions; Polaris owns the routing action.

### 5.6 SOL feedback boundaries

QC metrics feed SOL/autoresearch scoring as one signal among many. The SOL integration must:

1. Treat provider findings as noisy observations, not ground truth.
2. Weight findings by severity and attribution confidence.
3. Ignore `info` and most `low` findings unless aggregated into a pattern.
4. Include provider-level noise baselines so that a noisy provider does not over-penalize workers.
5. Expose both per-child and per-cluster QC summaries for autoresearch gates.

SOL scoring must never block a child solely because of QC findings; it may propose follow-up analysis or human review.

---

## 6. Lifecycle data flow

```text
Worker completes one bounded child
        │
        ▼
Foreman validates child result, commit, validation, and tracker state
        │
        ▼
All children complete
        │
        ▼
Closeout Librarian runs and produces documentation/cognition evidence
        │
        ▼
QC runs (completed-cluster level) if provider supports local review,
  OR after PR creation if provider requires a PR URL
        │
        ▼
QC provider output is parsed into normalized Polaris findings
        │
        ▼
Polaris persists a cluster-scoped QC result artifact
        │
        ▼
Polaris applies severity and attribution policy
        │
        ▼
Auto-fix is attempted only for policy-eligible findings
        │
        ▼
Remaining findings route to original worker, repair worker, follow-up issue, or operator review
        │
        ▼
QC metrics are summarized and fed into SOL/autoresearch scoring
```

Child-level QC follows the same parse/attribute/route steps but runs after a single child completes and before the next child is dispatched, only when policy-gated.

---

## 7. Default behavior and invariants

### 7.1 Default behavior

When `qc` is absent or disabled in config, Polaris behaves exactly as it does today:

- No QC provider is invoked.
- No QC artifacts are written.
- Finalize and loop behavior are unchanged.
- SOL scoring continues to use existing telemetry and result evidence.

### 7.2 Invariants

| Invariant | Description |
|---|---|
| **Polaris owns validation** | QC never replaces worker validation commands or finalize evidence gates. |
| **QC is external** | The QC provider is an external critic, not a Polaris runtime dependency. |
| **Default trigger is high-level** | PR-level and completed-cluster-level QC are the defaults; child-level is gated. |
| **Findings are normalized** | Every provider output is parsed into a Polaris-native schema before any policy or routing. |
| **Attribution is evidence-based** | Attribution uses commits, changed files, and result packets, not heuristics alone. |
| **Auto-fix is opt-in and conservative** | Auto-fix requires explicit policy, clean scope, and known validation. |
| **Repair routing is Polaris-owned** | QC suggests; Polaris decides where a finding is repaired. |
| **SOL treats QC as advisory** | QC findings are one of many scoring inputs and never the sole blocker. |

### 7.3 Non-goals

- Do not implement runtime QC code in this spec.
- Do not promote draft docs to doctrine without the existing SmartDocs promotion workflow.
- Do not make any external QC provider required.
- Do not change default Polaris behavior when QC is disabled.

---

## 8. Provider-Agnostic QC Repair Loop

> **Source analysis:** `smartdocs/raw/analysis/pol-500-provider-agnostic-qc-repair-loop-analysis.md`  
> **Governed by:** POL-501 implementation cluster

This section defines the implementation contract for the bounded QC repair loop. It must be read before any runtime changes land in `src/qc/`, `src/loop/`, `src/finalize/`, `src/cluster-state/`, or `src/autoresearch/`.

### 8.1 QC providers vs. worker providers

These two provider types are distinct and must never be conflated:

| Dimension | QC provider | Worker provider |
|---|---|---|
| Role | External critic — reviews code, emits findings | Executes assigned child implementation work |
| Code mutation | **Never.** QC providers must not mutate code directly. | Yes, within governed scope. |
| Dispatch | Invoked by `src/qc/orchestration.ts` at lifecycle triggers | Dispatched by `src/loop/dispatch.ts` via Worker Router |
| Output | Normalized `QcFinding` array + policy decision | WorkerPacket result, commit, validation evidence |
| Failure handling | Provider failure policy (`block`, `fallback`, `follow-up`, `skip`) | Orphan recovery, Medic referral |
| Config namespace | `polaris.config.json → qc.providers` | `polaris.config.json → routerPolicy` |

**Invariant:** QC providers never receive worker-provider dispatch. Repair workers that address QC findings execute through governed dispatch (Worker Router) with `worker_role: repair`.

### 8.2 Extended provider configuration

`QcProviderConfig` must support the following fields to enable execution, fallback, and policy without conflating QC providers with worker providers:

```ts
interface QcProviderExecutionConfig {
  name: string;
  mode: "local" | "pr" | "metrics-import";
  command?: string;           // CLI binary or entry point
  args?: string[];            // CLI arguments
  outputFormat?: "coderabbit" | "pr-agent" | "generic-json" | "jsonl" | "markdown";
  parser?: string;            // named parser in src/qc/providers/
  trigger?: "pr" | "completed-cluster" | "child";
  capabilities?: QcProviderCapability[];
  autoFixEligible?: boolean;
  timeoutMs?: number;
  rateLimitPolicy?: "fallback" | "block" | "follow-up" | "skip";
  failurePolicy?: "fallback" | "block" | "follow-up" | "skip";
  primary?: boolean;
  fallback?: string[];        // ordered provider names to try on failure
  severityMapping?: Record<string, QcSeverity>;
}
```

Config schema validation lives in `src/config/schema.ts` and `src/config/validator.ts`. Neither the repair loop orchestration nor the normalized result schema depends on which fields are present in any specific provider config entry.

### 8.3 Normalized provider failure model

Provider execution failures are classified separately from QC findings. A provider failure is one of:

| Failure class | Meaning |
|---|---|
| `timeout` | Provider did not complete within `timeoutMs`. |
| `rate-limited` | Provider returned a rate-limit signal. |
| `auth-failed` | Provider authentication failed. |
| `command-not-found` | CLI binary not on PATH. |
| `nonzero-exit` | Provider exited with non-zero code and no parseable output. |
| `parse-failed` | Provider output could not be parsed by the configured parser. |
| `empty-output` | Provider produced no output or an empty findings array. |
| `unsupported-mode` | Provider does not support the requested mode. |
| `provider-unavailable` | Provider is not reachable (network, auth, or config missing). |

All provider attempts produce telemetry regardless of outcome. Policy distinguishes:

- Primary succeeds → proceed with findings.
- Primary fails and fallback succeeds → record primary failure, proceed with fallback findings.
- All providers fail → outcome is `all-providers-failed` (see §8.7).
- Provider output unusable (`empty-output`, `parse-failed`) → apply `failurePolicy`.
- Provider skipped by trigger or mode → outcome is `skipped`; no findings.

### 8.4 Repair packet manifest

When actionable findings remain after normalization and policy, `src/qc/` compiles a repair packet manifest at:

```text
.polaris/clusters/<cluster-id>/qc/repair-rounds/<round>/repair-packets.json
```

Each packet in the manifest has these fields:

| Field | Type | Description |
|---|---|---|
| `packet_id` | string | Unique identifier for this repair packet. |
| `round` | number | Repair round number (1-based). |
| `source_qc_run_ids` | string[] | QC run IDs that produced the findings in this packet. |
| `finding_ids` | string[] | Normalized finding IDs addressed by this packet. |
| `severity_floor` | QcSeverity | Highest severity finding in this packet. |
| `title` | string | Short human-readable description of the repair task. |
| `root_cause_hint` | string | Guidance for the repair worker about likely root cause. |
| `allowed_scope` | string[] | File paths or globs the repair worker is allowed to touch. |
| `prohibited_scope` | string[] | File paths or globs the repair worker must not touch. |
| `validation_commands` | string[] | Commands to run after repair to confirm the finding is resolved. |
| `routing_target` | string | One of: `repair-worker`, `original-worker`, `follow-up`, `operator-review`, `medic`. |
| `parallel_group` | string \| null | Group label for packets that may run concurrently. |
| `conflicts_with` | string[] | Packet IDs that must not run in the same round as this packet. |
| `requires_medic` | boolean | When true, only a Medic worker may address this packet. |
| `status` | string | `pending`, `dispatched`, `complete`, `failed`, `skipped`. |

### 8.5 Packet grouping rules

1. Group findings in the same file and root-cause category when line ranges overlap or are adjacent.
2. Group subsystem findings when they share a route and no file-level overlap would make the packet unsafe.
3. Do not group `security`, `auth`, `data-loss`, `migration`, or `governance` findings with unrelated work.
4. Do not run packets in parallel when `allowed_scope` overlaps or either packet touches shared governance/config files.
5. Route broad, low-confidence, or cross-cutting findings to `repair-worker` or `operator-review` rather than `original-worker`.
6. Route validation failure, state corruption, or failed-repair-worker results to Medic via existing Medic boundaries.

### 8.6 Bounded repair-round state machine

**Initial max repair rounds: `2`** (overridable by `polaris.config.json → qc.maxRepairRounds`).

States:

| State | Description |
|---|---|
| `qc_review_requested` | QC trigger fired; providers not yet invoked. |
| `qc_provider_attempted` | At least one provider has been invoked. |
| `qc_results_normalized` | All provider outputs parsed into `QcFinding` array. |
| `repair_packets_compiled` | Repair packet manifest written for this round. |
| `repair_packets_dispatched` | Repair workers dispatched as governed children. |
| `repair_results_collected` | All repair workers in this round have returned results. |
| `qc_rerun_requested` | Post-repair QC rerun triggered. |
| `qc_passed` | All findings resolved; loop exits cleanly. |
| `max_rounds_reached` | Round limit hit; unresolved findings escalate (see §8.7). |
| `operator_review_required` | One or more findings escalated to operator; loop suspends. |
| `medic_referral_required` | One or more packets require Medic; loop suspends. |

Loop rules:

- QC providers are external critics, not worker providers. They never appear in the Worker Router dispatch chain.
- Repair workers are normal governed workers with `worker_role: repair` dispatched through `src/loop/dispatch.ts`.
- Each repair round consumes the prior round's unresolved findings.
- A finding may be marked `repaired` only after a post-repair QC run or explicit validation evidence.
- A repeated finding after max rounds escalates to operator review or Medic referral depending on failure class.
- The loop stops immediately when any of the terminal conditions in §8.7 is reached.

### 8.7 Terminal outcomes

| Outcome | Trigger | Resolution |
|---|---|---|
| **pass** | All findings are `repaired`, `autofixed`, `waived`, or `info`/`follow-up`. | Loop exits; delivery proceeds. |
| **follow-up / log** | Only `low`/`info` findings remain; policy allows passive handling. | Findings logged or filed as tracker follow-up; delivery proceeds. |
| **operator review** | `critical` or `high` findings remain unresolved, or a wavier is needed. | Loop suspends; operator must resolve or waive before delivery. |
| **max rounds reached** | Repair rounds exhausted (`round > maxRepairRounds`) with open `medium`+. | Unresolved findings escalate to operator review unless all are `low`/`info`. |
| **Medic referral** | Packet requires Medic or repair worker failed for a governed packet. | Loop suspends; Medic dispatched through standard Medic boundaries. |
| **all providers failed** | Every configured provider failed or was unavailable. | Applies `failurePolicy` for each; loop treats aggregate as `follow-up` or `block` per config. |

### 8.8 Parallel safety rules

Repair packets in the same round may run in parallel only when **all** of the following are true:

1. `parallel_group` is the same non-null value, **or** they have no `conflicts_with` relationship.
2. `allowed_scope` sets are disjoint (no overlapping files or globs).
3. Neither packet touches shared governance/config files (e.g., `polaris.config.json`, `package.json`, migration files).
4. Neither packet has `requires_medic: true`.
5. `maxActiveWorkers` allows more than one concurrent slot.

Packets that do not satisfy all five conditions must be serialized within the round.

### 8.9 SOL telemetry events for the repair loop

The following JSONL events must be emitted to the run telemetry file. Each event includes `run_id`, `cluster_id`, `round`, `provider` (when applicable), `qc_run_id` (when applicable), `packet_id` (when applicable), severity counts, and source artifact paths.

| Event | When emitted |
|---|---|
| `qc-provider-attempted` | Before invoking each provider. |
| `qc-provider-fallback-attempted` | When falling back to a secondary provider. |
| `qc-provider-failed` | When a provider returns a failure class (see §8.3). |
| `qc-provider-executed` | After a provider completes successfully and output is retained. |
| `qc-findings-normalized` | After all providers' output is parsed into `QcFinding` array. |
| `qc-repair-round-started` | At the start of each repair round. |
| `qc-repair-packets-compiled` | After repair packet manifest is written. |
| `qc-repair-packet-dispatched` | When a repair worker is dispatched for a packet. |
| `qc-repair-packet-complete` | When a repair worker returns a result for a packet. |
| `qc-rerun-started` | When post-repair QC rerun is triggered. |
| `qc-repair-round-complete` | At the end of each repair round (before rerun). |
| `qc-max-rounds-reached` | When `round > maxRepairRounds` with open findings. |
| `qc-operator-review-required` | When a finding escalates to operator review. |
| `qc-medic-referral-required` | When a packet escalates to Medic. |

SOL evidence fields added by the repair loop (not present in pre-POL-501 artifacts):

- `provider_attempt_count` — total provider invocations across fallback chain.
- `provider_failure_class` — failure class for failed providers.
- `repair_round_count` — number of repair rounds executed.
- `compiled_packet_count` — total repair packets compiled this run.
- `repair_worker_outcomes` — per-packet: `{packet_id, worker_id, status, finding_ids_resolved}`.
- `unresolved_finding_escalation_reason` — why a finding was not resolved (`max-rounds`, `operator-review`, `medic-referral`).
- `max_round_stop_reason` — human-readable reason the round limit was hit.
- `medic_referral_packet_ids` — packet IDs referred to Medic.

---

## 9. Related documents

- `smartdocs/raw/analysis/pol-461-quality-control-analysis.md` — source analysis for POL-461/POL-471.
- `smartdocs/raw/analysis/pol-500-provider-agnostic-qc-repair-loop-analysis.md` — source analysis for POL-500/POL-501 repair loop.
- `smartdocs/architecture/quality-control-lifecycle.md` — lifecycle and operational boundaries.
- `smartdocs/specs/active/worker-router-architecture.md` — provider-neutral routing design patterns.
- `smartdocs/specs/active/worker-lifecycle-state-machine.md` — canonical worker states and transitions.
- `smartdocs/specs/active/worker-telemetry-spec.md` — telemetry event catalog.
- `smartdocs/specs/active/polaris-artifact-promotion-commit-hygiene-policy.md` — durable artifact promotion rules.
- `src/qc/POLARIS.md` — QC subsystem operational guidance.
- `src/finalize/POLARIS.md` — finalize relationship with QC gates.
- `src/loop/POLARIS.md` — loop trigger relationship with QC.
- `src/cluster-state/POLARIS.md` — QC artifact storage in cluster state.
- `src/autoresearch/POLARIS.md` — QC metrics as SOL inputs.
