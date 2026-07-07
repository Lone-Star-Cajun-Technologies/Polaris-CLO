---
kind: spec
status: active
source: POL-471
cluster: POL-470
created: 2026-07-07
implements:
related: smartdocs/raw/analysis/pol-461-quality-control-analysis.md,smartdocs/architecture/quality-control-lifecycle.md,smartdocs/specs/active/worker-router-architecture.md,smartdocs/specs/active/worker-lifecycle-state-machine.md,smartdocs/specs/active/worker-telemetry-spec.md,smartdocs/specs/active/polaris-artifact-promotion-commit-hygiene-policy.md
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

## 8. Related documents

- `smartdocs/raw/analysis/pol-461-quality-control-analysis.md` — source analysis.
- `smartdocs/architecture/quality-control-lifecycle.md` — lifecycle and operational boundaries.
- `smartdocs/specs/active/worker-router-architecture.md` — provider-neutral routing design patterns.
- `smartdocs/specs/active/worker-lifecycle-state-machine.md` — canonical worker states and transitions.
- `smartdocs/specs/active/worker-telemetry-spec.md` — telemetry event catalog.
- `smartdocs/specs/active/polaris-artifact-promotion-commit-hygiene-policy.md` — durable artifact promotion rules.
- `src/finalize/POLARIS.md` — finalize relationship with QC gates.
- `src/loop/POLARIS.md` — loop trigger relationship with QC.
- `src/cluster-state/POLARIS.md` — QC artifact storage in cluster state.
- `src/autoresearch/POLARIS.md` — QC metrics as SOL inputs.
