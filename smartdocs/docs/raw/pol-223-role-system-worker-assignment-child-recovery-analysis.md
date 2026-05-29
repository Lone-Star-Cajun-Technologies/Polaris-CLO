# POL-223: Role System, Worker Assignment, and Child Recovery — Analysis

**Issue:** POL-223
**Date:** 2026-05-29
**Status:** Raw — candidate for promotion
**Analysis Source:** POL-201, POL-211, PR-55, PR-56, POL-203 dispatch failure

---

## 1. Role System

### 1.1 Canonical Roles

Polaris defines four canonical roles. These are agent personas — not code modules. Each role maps to a distinct authority boundary enforced at bootstrap by the CLO runtime.

#### Foreman

**Responsibilities:**
- Select next executable child from cluster plan
- Construct worker packet with all required fields
- Dispatch worker via configured adapter
- Checkpoint state after each child completes
- Enforce context budget (children, files touched)
- Escalate blockers to operator
- Own full worker lifecycle (launch → seal)
- Verify seal and result artifact before marking child complete
- Open PR at cluster completion

**Authority boundaries:**
- Read: full repo state, cluster artifacts, state machine
- Write: `.polaris/runs/`, `.polaris/clusters/<id>/packets/`, state checkpoints, telemetry
- May dispatch: Yes
- May implement: No

**Prohibited actions:**
- Inline code implementation
- Reasoning about source files beyond packet construction
- Expanding child scope beyond cluster plan
- Modifying packets post-emit
- Skipping checkpoint steps
- Dispatching more than one child per continue epoch

**Escalation rules:**
- Missed heartbeat (>120s since last_heartbeat_at) → emit escalation-initiated, pause
- Worker exit_code !== 0 → emit worker-result(failed), escalate
- Dispatch failure → emit worker-assignment-failed, try fallback chain
- Budget exhaustion → stop cluster, report to operator
- Seal failure → halt, do not mark child complete

---

#### Worker

**Responsibilities:**
- Read bootstrap packet and execute the single assigned child
- Implement changes within the scope defined in the packet
- Run validation (build, tests, lint)
- Commit changes
- Write CompactReturn to expected_result_path
- Emit heartbeat telemetry at least every 60 seconds
- Acknowledge dispatch within launch_to_first_heartbeat_ms (30s)

**Authority boundaries:**
- Read: full repo (within packet scope)
- Write: source files within packet allowed scope, test files, commit
- May implement: Yes
- May dispatch: No

**Prohibited actions:**
- Modifying cluster plan or clusters.json
- Dispatching other children
- Interacting with cluster orchestration (polaris loop dispatch/continue)
- Expanding scope beyond packet bounds

**Escalation rules:**
- Blocked by dependency or ambiguity → set exit_code=1, populate blockers array in CompactReturn
- Test failure that cannot be resolved within scope → escalate via CompactReturn
- Scope ambiguity → stop and report, do not guess

---

#### Analyst

**Responsibilities:**
- Fetch issue from tracker and parse scope
- Map relevant code files for the issue
- Assess feasibility, detect blockers
- Produce clusters.json defining child issues
- Write analysis documents to `smartdocs/docs/raw/`
- Create child Linear issues

**Authority boundaries:**
- Read: full repo (read-only)
- Write: `smartdocs/docs/raw/`, `.polaris/clusters/<id>/clusters.json`
- May create Linear issues: Yes
- May implement: No
- May dispatch: No

**Prohibited actions:**
- Source code mutation
- `polaris loop dispatch` or `polaris loop continue`
- PR creation
- Promoting docs to `specs/active/` or `doctrine/active/` (that is Librarian's role)

**Escalation rules:**
- Blocked issue (missing dependency, unclear scope) → stop, write blocker report, do not create plan
- Non-executable issue (already done, wrong type) → report and stop

---

#### Librarian

**Responsibilities:**
- Ingest raw documents from `smartdocs/docs/raw/` drop zone
- Classify by authority level (raw → candidate → active → doctrine)
- Check for conflicts with existing docs
- Place and link in canonical target location
- Promote candidates to `specs/active/` or `doctrine/active/` (with approval)
- Deprecate superseded documents

**Authority boundaries:**
- Read: full smartdocs tree
- Write: `smartdocs/docs/` (classification and placement only)
- May promote to doctrine/active or architecture: only with explicit operator approval
- May implement: No
- May dispatch: No

**Prohibited actions:**
- Source code changes
- Creating Linear issues
- Dispatch operations
- Silent promotion to doctrine/active or architecture/decisions

**Escalation rules:**
- Conflict detected → surface conflict report, await approval before placement
- Promotion to doctrine/active or architecture → always require explicit operator confirmation

---

### 1.2 CLO Runtime (Not a Role)

The **Polaris CLO (Command Line Orchestrator)** is the runtime that enforces role boundaries. It is not an agent persona and is not assigned to a session.

CLO responsibilities:
- Manage dispatch/continue epoch counters
- Enforce dispatch boundary hard failures (process.exit(1))
- Own telemetry append-only log
- Validate state transitions

CLO is invisible to workers. Workers interact with it only indirectly (via packet consumption, heartbeat emission, CompactReturn write).

---

### 1.3 Role File Architecture

**Canonical location:** `.polaris/roles/`

```text
.polaris/roles/
  foreman.md       # Foreman role definition
  worker.md        # Worker role definition
  analyst.md       # Analyst role definition
  librarian.md     # Librarian role definition
  local/           # User customization overrides (additive only)
```

**File format:** Markdown with a YAML front matter header:

```yaml
---
role: foreman
version: 1
---
```

**Loading behavior:** The skill's SKILL.md references the role file path. The runtime injects role context into the bootstrap packet at session start. If no role file is found, the runtime rejects the dispatch.

**Inheritance model:** No class inheritance. Roles are independent documents. Shared base constraints are documented separately in a `base-constraints.md` (future). Roles do not inherit from each other.

**User customization model:** Users may place override files in `.polaris/roles/local/`. Local overrides are additive only — they may add guidance but may not remove or relax existing constraints. The runtime merges local guidance after the base role definition.

**Future marketplace compatibility:** Third-party roles may be referenced via `.polaris/roles/marketplace/<role-name>.md`. Marketplace roles are loaded by explicit reference in SKILL.md, never auto-discovered.

---

## 2. Skill Binding

### 2.1 Canonical Skill-to-Role Bindings

| Skill | Role | Authority Level |
|---|---|---|
| `polaris-analyze` | Analyst | Read repo + write raw docs + create issues |
| `polaris-run` | Foreman | Coordinate dispatch + checkpoint |
| Worker Packet execution | Worker | Implement within packet scope |
| `docs-ingest` | Librarian | Ingest to raw/, classify |
| `docs-promote` | Librarian | Promote candidate → active/doctrine |

### 2.2 Binding Mechanism

**Decision: Embedded in SKILL.md header** (not dynamically injected).

Rationale:
- Skills are the unit of dispatch. The role is a property of the skill, not of the session.
- Dynamic injection would require the runtime to resolve role from context — adding ambiguity.
- Embedding in SKILL.md makes the binding auditable without executing the skill.

SKILL.md header format:
```yaml
---
skill: polaris-run
role: foreman
role_file: .polaris/roles/foreman.md
version: 2
---
```

The runtime reads `role_file` and injects the content into the session bootstrap context.

### 2.3 Role Marketplace Compatibility

Future marketplace skills declare their own role binding. If the role is a marketplace role, it must exist in `.polaris/roles/marketplace/` before the skill can execute. The runtime validates role presence before dispatch.

---

## 3. Bootstrap and Runtime Injection

### 3.1 Bootstrap Packet Role Fields

The following fields are added to the worker bootstrap packet (extends existing ChildDispatchRecord):

```json
{
  "role": "worker",
  "role_authority": "implementation",
  "may_implement": true,
  "may_assign_workers": false,
  "prohibited_actions": [
    "modify-cluster-plan",
    "dispatch-children",
    "polaris-loop-dispatch",
    "polaris-loop-continue"
  ]
}
```

For Foreman packets:
```json
{
  "role": "foreman",
  "role_authority": "coordination-only",
  "may_implement": false,
  "may_assign_workers": true,
  "prohibited_actions": [
    "inline-implementation",
    "scope-expansion",
    "skip-checkpoint"
  ]
}
```

### 3.2 Status Output Surface

`polaris status` output includes a role block:

```text
Role:              Foreman
Authority:         Coordination Only
May Implement:     No
May Assign Workers: Yes
```

`polaris loop status` output includes per-child role tracking:

```text
Active Child:      POL-205
Dispatched To:     subagent
Worker Role:       Worker
Acknowledged:      Yes (2026-05-29T19:45:00Z)
Last Heartbeat:    12s ago
```

### 3.3 Runtime Map Extension

`file-routes.json` domain entries are extended with a `role_owner` field identifying which role owns cognition for that domain:

```json
{
  "domain": "cli",
  "route": "src/cli/",
  "taskchain": "polaris-cli",
  "role_owner": "worker",
  "confidence": 0.9
}
```

`role_owner` values: `worker` | `foreman` | `analyst` | `librarian` | `any`

---

## 4. Worker Assignment

### 4.1 Assignment Decision Tree

```text
Dispatch triggered
        │
        ▼
Is an explicit --provider flag set?
  YES → Direct-worker dispatch (no fallback)
        │
        └─ Provider available? → dispatch
           Provider unavailable? → escalate to operator (pending-escalation)
        │
  NO  ▼
Is a provider configured in .polaris/config?
  YES → Direct-worker dispatch with configured provider (no fallback)
        │
        └─ Provider available? → dispatch
           Provider unavailable? → escalate to operator
        │
  NO  ▼
Is an internal subagent available?
  YES → Delegated dispatch
        │
        └─ Try: subagent spawn
           Fallback: external-process
           Fallback: human-handoff
           Fallback: pending-escalation
        │
  NO  ▼
No provider available → pending-escalation
```

### 4.2 Assignment Evidence Requirements

All scenarios require durable evidence before dispatch is considered complete:

| Field | When Written | Required |
|---|---|---|
| `dispatch_id` | Before dispatch attempt | Always |
| `dispatched_at` | Before dispatch attempt | Always |
| `packet_path` | Before dispatch attempt | Always |
| `worker_id` | After provider accepts | If provider assigned |
| `provider` | After provider resolution | Always |
| `session_id` | After provider connects | If attachment_capable |

Dispatch is not complete (from the Foreman's perspective) until `packet_path` is written and durable. `worker_id` is required for telemetry but may be null until acknowledgment.

### 4.3 Acknowledgment Requirements

Worker must emit `worker-acknowledged` telemetry within `launch_to_first_heartbeat_ms` (30 seconds).

Acknowledgment event payload:
```json
{
  "event": "worker-acknowledged",
  "dispatch_id": "<uuid>",
  "child_id": "POL-205",
  "worker_identity": "<provider-identity>",
  "acknowledged_at": "<iso-timestamp>"
}
```

Foreman behavior on acknowledgment:
- Set `acknowledged_at` on ChildDispatchRecord
- Transition state machine: `handoff-pending` → `acknowledged`
- Begin heartbeat monitoring

Foreman behavior on acknowledgment timeout:
- Transition state machine: `handoff-pending` → `orphaned`
- Emit `child-recovery-initiated` with `reason: no-acknowledgment`
- Do not proceed to next child; escalate

### 4.4 Fallback Behavior (Delegated Dispatch)

```text
subagent spawn failed?
  → emit worker-assignment-failed(subagent)
  → try external-process adapter

external-process failed?
  → emit worker-assignment-failed(external-process)
  → try human-handoff

human-handoff unavailable?
  → emit worker-assignment-failed(human-handoff)
  → emit escalation-initiated
  → set state: pending-escalation
  → halt; operator must resolve
```

Each attempt gets a new `dispatch_id`. Failed attempt records are retained in telemetry for audit.

---

## 5. Child Recovery

### 5.1 Reference Case: POL-203 Dispatch Failure

In the POL-203 failure, a worker was dispatched but produced no result artifact. The Foreman had no mechanism to detect the gap or trigger recovery. The child remained orphaned with no recovery path.

This analysis defines the recovery architecture to prevent recurrence.

### 5.2 Recovery Scenarios

**Scenario A: Packet exists, no worker assignment**

Condition: `packet_path` written but `worker_id` is null after `launch_timeout` (30s)
Cause: Provider not reached after dispatch attempt
Recovery: Safe to redispatch — no worker ever ran
```text
detect (no worker_id after timeout)
→ emit child-recovery-initiated(reason: no-worker-assignment)
→ clear dispatch_record (keep dispatch_id for audit, generate new one)
→ transition state: handoff-pending → orphaned
→ requeue child
→ emit child-requeued
→ redispatch (no operator approval required)
```

**Scenario B: No acknowledgment**

Condition: `worker_id` present but `acknowledged_at` null after `launch_to_first_heartbeat_ms` (30s)
Cause: Provider accepted dispatch but worker never started
Recovery: Likely safe to redispatch
```text
detect (no acknowledged_at after 30s)
→ emit child-recovery-initiated(reason: no-acknowledgment)
→ transition: handoff-pending → orphaned
→ requeue child
→ emit child-requeued
→ redispatch (no operator approval required — worker never acknowledged work)
```

**Scenario C: No heartbeat (worker went silent)**

Condition: `acknowledged_at` present but `last_heartbeat_at` more than `orphan_timeout_ms` (10 min) ago with no `worker-result` event
Cause: Worker started but stopped reporting (crash, hang, disconnect)
Recovery: Requires operator approval — partial execution may have occurred
```text
detect (last_heartbeat_at > orphan_timeout_ms without result)
→ emit worker-orphaned
→ transition: running → orphaned
→ emit recovery-approval-requested(reason: potential-partial-execution)
→ HALT — await operator approval
→ (on approval) emit recovery-approved
→ generate new dispatch_id, requeue
→ emit child-requeued
→ redispatch
```

**Scenario D: No result artifact**

Condition: `worker-result` telemetry event received but `expected_result_path` contains no valid CompactReturn
Cause: Worker exited abnormally after emitting completion event
Recovery: Depends on whether commits exist
```text
detect (worker-result event received, expected_result_path missing or invalid)
→ check git log for commits in child scope
→ if no commits: safe to redispatch
    → emit child-recovery-initiated(reason: missing-result-artifact-no-commits)
    → requeue, redispatch
→ if commits exist: partial execution
    → emit child-recovery-initiated(reason: missing-result-artifact-commits-found)
    → emit recovery-approval-requested
    → HALT — operator must decide: accept partial, revert, or manual intervention
```

**Scenario E: Packet exists, stale dispatch (long time since dispatched_at, no state change)**

Condition: `dispatched_at` more than a configurable `stale_dispatch_timeout` (default: 30 min) ago, state still `handoff-pending` with no subsequent events
Cause: Dispatch was initiated but the session ended without completing handoff
Recovery: Safe to redispatch
```text
detect (dispatched_at + stale_dispatch_timeout < now(), state = handoff-pending)
→ emit child-recovery-initiated(reason: stale-dispatch)
→ transition: handoff-pending → orphaned
→ requeue, emit child-requeued
→ redispatch (no operator approval required)
```

### 5.3 Recovery Workflow Summary

```text
1. Detect recovery condition (time-based OR evidence-based)
2. Emit child-recovery-initiated { child_id, dispatch_id, recovery_reason, detected_at }
3. Transition state to orphaned
4. Preserve original dispatch_id in audit trail
5. Generate new dispatch_id for redispatch
6. If operator approval required:
   → emit recovery-approval-requested
   → HALT — do not redispatch until approved
7. (If approved or no approval needed): emit child-requeued
8. Redispatch with new packet (new dispatch_id, same child scope)
```

### 5.4 Stale Dispatch Detection

Two detection modes:

**Time-based:** Compare `now()` against state-specific timeout thresholds:

| State | Timeout Field | Default |
|---|---|---|
| `handoff-pending` (no worker_id) | `launch_timeout` | 30s |
| `handoff-pending` (worker_id present, no ack) | `launch_to_first_heartbeat_ms` | 30s |
| `running` (no heartbeat) | `orphan_timeout_ms` | 10 min |
| `handoff-pending` (stale dispatch) | `stale_dispatch_timeout` | 30 min |

**Evidence-based:** Scan `.polaris/clusters/<id>/packets/` for packets whose `dispatch_id` has no matching `worker-acknowledged` or `worker-result` event in the telemetry log within the relevant timeout window.

### 5.5 Recovery Telemetry Events

All recovery events extend the base telemetry schema.

```text
child-recovery-initiated
  Fields: child_id, dispatch_id, recovery_reason, detected_at
  Reason values: no-worker-assignment | no-acknowledgment | no-heartbeat |
                 missing-result-artifact-no-commits | missing-result-artifact-commits-found |
                 stale-dispatch

child-orphaned
  Fields: child_id, dispatch_id, last_heartbeat_at (nullable), orphaned_at

recovery-approval-requested
  Fields: child_id, dispatch_id, recovery_reason, operator_notified_at

recovery-approved
  Fields: child_id, dispatch_id, approved_by, approved_at

child-requeued
  Fields: child_id, new_dispatch_id, previous_dispatch_id, requeued_at
```

### 5.6 POL-203 Recovery Path

POL-203 (cluster-state schema + atomic store) was dispatched, the worker ran, but left no result artifact and no heartbeat record.

Under the recovery architecture defined here, the recovery path for POL-203 would have been:

1. Foreman detects `missing-result-artifact` scenario (Scenario D)
2. Check git log — were any commits made in scope `src/loop src/tracker`?
3. If no commits: safe redispatch
4. If commits: emit `recovery-approval-requested`, operator reviews partial work, decides next step

The concrete resolution depends on whether partial commits exist. The operator can choose to:
- Accept partial work and mark child Done with manual finalization
- Revert commits and do a clean redispatch
- Manually complete the remaining work

---

## 6. Connect Compatibility Addendum

This section extends `smartdocs/docs/specs/active/connect-compatibility.md` (POL-216). It does not replace it.

### 6.1 Role Metadata to Store Today

The following fields should be added to `ChildDispatchRecord` now, to support future Connect features:

| Field | Type | Purpose |
|---|---|---|
| `role` | `string` | Identify worker role for Connect UI ("worker", "analyst", etc.) |
| `role_authority` | `string` | What the worker can do ("implementation", "coordination-only", "analysis") |
| `may_implement` | `boolean` | Gate Connect's "request implementation" button |
| `session_type` | `string` | Distinguish session character ("implementation", "analysis", "coordination") |

These are additive to the 5 fields already identified in POL-216 (`worker_id`, `session_id`, `attachment_capable`, `heartbeat_count`, `first_heartbeat_at`).

### 6.2 Connect UI Implications

| Connect Feature | Role Field Used | Behavior |
|---|---|---|
| Worker identity display | `role` | Show "Worker" or "Analyst" badge on session card |
| Interrupt button | `may_implement` | Only show interrupt option for workers with may_implement=true |
| Session attachment | `attachment_capable` (POL-216) + `role` | Show attach button only for implementation workers |
| Role-aware monitoring | `role_authority` | Filter monitoring view by authority level |

### 6.3 session_type Values

| Value | Meaning |
|---|---|
| `implementation` | Worker session; may modify source |
| `analysis` | Analyst session; read-only on source |
| `coordination` | Foreman session; dispatch authority |
| `documentation` | Librarian session; smartdocs only |

---

## 7. Migration Plan

### 7.1 Pre-Requisites

- POL-201 cluster (runtime state consolidation) must be complete before Wave 4 and Wave 5 can be implemented. Waves 4 and 5 depend on the cluster-state schema established by POL-201.
- POL-211 cluster (foreman-worker architecture specs) is complete and provides the foundation for Waves 2 and 3.

### 7.2 Gap Inventory

| Gap ID | Description | Wave |
|---|---|---|
| GAP-R01 | `.polaris/roles/` directory and role files do not exist | 0 |
| GAP-R02 | SKILL.md headers do not reference role files | 1 |
| GAP-R03 | Bootstrap packets do not include role fields | 2 |
| GAP-R04 | `polaris status` does not surface role context | 2 |
| GAP-R05 | `file-routes.json` domains lack `role_owner` field | 3 |
| GAP-R06 | Worker assignment does not implement 4-scenario decision tree | 4 |
| GAP-R07 | No acknowledgment timeout detection | 4 |
| GAP-R08 | No orphan detection (heartbeat loss) | 5 |
| GAP-R09 | No stale dispatch detection | 5 |
| GAP-R10 | No recovery workflow (child-recovery-initiated et al.) | 5 |
| GAP-R11 | Recovery telemetry events not defined in telemetry spec | 5 |
| GAP-R12 | `ChildDispatchRecord` lacks role fields for Connect | 6 |

### 7.3 Implementation Waves

**Wave 0 — Role File Foundation (no code changes)**
- Create `.polaris/roles/foreman.md`, `worker.md`, `analyst.md`, `librarian.md`
- These are documentation files; no source changes required
- Deliverable: role files in repo
- Closes: GAP-R01

**Wave 1 — Skill Binding**
- Update SKILL.md headers in all skills to reference role file
- Deliverable: all SKILL.md files have `role` and `role_file` front matter
- Closes: GAP-R02

**Wave 2 — Bootstrap Injection**
- Add role fields to worker packet construction in `src/loop/worker-packet.ts`
- Add role surface to `polaris status` output in `src/cli/`
- Deliverable: role visible in every bootstrap packet and status output
- Closes: GAP-R03, GAP-R04
- Pre-requisite: Wave 1

**Wave 3 — Runtime Map Extension**
- Extend `file-routes.json` schema with `role_owner` field
- Update `polaris map validate` to check role_owner values
- Deliverable: file-routes.json has role_owner on all domain entries
- Closes: GAP-R05

**Wave 4 — Worker Assignment Model**
- Implement 4-scenario assignment decision tree in `src/loop/dispatch.ts`
- Implement acknowledgment timeout detection
- Deliverable: dispatch follows canonical assignment model; unacknowledged workers trigger escalation
- Closes: GAP-R06, GAP-R07
- Pre-requisite: POL-201 Wave 1 (cluster-state schema)

**Wave 5 — Child Recovery**
- Implement orphan detection (heartbeat monitoring) in `src/loop/`
- Implement stale dispatch detection
- Implement recovery workflow (reset, requeue, redispatch)
- Emit recovery telemetry events
- Deliverable: orphaned children are detected and recovered automatically or with operator approval
- Closes: GAP-R08, GAP-R09, GAP-R10, GAP-R11
- Pre-requisite: POL-201 Wave 2 (cluster-state atomic store)

**Wave 6 — Connect Role Fields**
- Add `role`, `role_authority`, `may_implement`, `session_type` to `ChildDispatchRecord` schema
- Update checkpoint writes to populate these fields
- Deliverable: all ChildDispatchRecords include role metadata
- Closes: GAP-R12
- Pre-requisite: Wave 2 (role fields in packets)

### 7.4 Connect Readiness Gate

**Minimum Connect readiness (role visibility):** Waves 0–2 complete
**Full Connect role integration:** Waves 0–2 + Wave 6 complete
**Full operational recovery:** Waves 0–5 complete

---

## 8. Deliverable Map → IMPLEMENT Cluster

The following child issues in POL-224 correspond to the deliverables from this analysis:

| Deliverable | Child Issue | Source Section |
|---|---|---|
| Role Architecture Specification | POL-225 | §1 |
| Skill Binding Specification | POL-226 | §2 |
| Runtime Role Injection Specification | POL-227 | §3 |
| Worker Assignment Specification | POL-228 | §4 |
| Child Recovery Specification | POL-229 | §5 |
| Connect Compatibility Addendum | POL-230 | §6 |
| Role System Migration Plan | POL-231 | §7 |

Each child issue writes one spec document to `smartdocs/docs/specs/active/` via docs-promote.
