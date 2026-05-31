---
kind: spec
status: active
source: POL-256
implements:
related: ["POL-240", "POL-241", "POL-242", "POL-257"]
supersedes:
superseded_by:
depends_on: ["provider-capability-matrix.md", "foreman-worker-architecture.md", "execution-adapters.md"]
validates:
source_paths:
  - src/config/schema.ts
  - src/loop/dispatch.ts
  - src/loop/execution-adapter.ts
  - src/loop/worker-packet.ts
  - polaris.config.json
---

# Provider Role Dispatch Governance

> Analysis for POL-256. Defines provider role config, fallback policy, user override rules, forbidden-provider enforcement, and decision logging. Feeds implementation child issues POL-258 through POL-263.

## Core doctrine

Polaris owns provider selection. Agents do not choose their own provider. Every provider decision is logged before execution begins. The config is the source of truth; agents may request a role but the config maps that role to a provider.

---

## 1. Provider Role Config Schema

### Current state

`src/config/schema.ts` has `RoleExecutionConfig` with a single optional `provider?: string` field. This provides a per-role override but no fallback list, no allowlist/denylist, and no native-subagent gate.

```typescript
// Current — insufficient
interface RoleExecutionConfig {
  adapter?: string;
  provider?: string;   // single provider, no fallback, no enforcement
  model?: string;
  command?: string;
  args?: string[];
}
```

### Proposed extension

Add `RoleProviderPolicy` alongside (not replacing) `RoleExecutionConfig`, and add a `providerPolicy` section to `ExecutionConfig`.

```typescript
/** Governance policy for provider selection for a given role. */
interface RoleProviderPolicy {
  /**
   * Ordered provider list for this role.
   * providers[0] is the default. providers[1..] are fallbacks tried in order.
   * An empty array means the role is disabled — all dispatch to this role is rejected.
   * Omitting this field means no role-specific policy; falls back to execution.rotation.
   */
  providers: string[];

  /**
   * When true, the native same-session subagent dispatch (agent-subtask adapter)
   * is permitted for this role. Default: false.
   * Set to true only for roles where same-session execution is safe and intentional
   * (e.g. analyst in a Claude Code session).
   */
  allowNativeSubagent?: boolean;

  /**
   * When true, fallback to the next provider is never attempted — the run stops
   * and escalates to the user. Default: false.
   * Intended for roles where provider consistency is required (e.g. reviewer/QC).
   */
  noFallback?: boolean;
}

// Addition to ExecutionConfig:
interface ExecutionConfig {
  adapter: string;
  providers: Record<string, ProviderConfig>;
  rotation?: string[];
  allowCrossAgentFallback?: boolean;
  roles?: Partial<Record<ExecutionRole, RoleExecutionConfig>>;

  /**
   * Per-role provider governance policy.
   * When present for a role, governs which providers are allowed, the fallback
   * order, and whether native subagent dispatch is permitted.
   * When absent for a role, dispatch falls back to execution.rotation.
   */
  providerPolicy?: Partial<Record<ExecutionRole, RoleProviderPolicy>>;
}
```

### Example polaris.config.json with provider policy

```json
{
  "execution": {
    "adapter": "terminal-cli",
    "providers": {
      "copilot": { "command": "copilot", "args": ["-p", "{{worker_prompt}}", "--autopilot", "--allow-all-tools"] },
      "codex":   { "command": "codex",   "args": ["{{worker_prompt}}"] },
      "claude":  { "command": "claude",  "args": ["--print", "--dangerously-skip-permissions", "{{worker_prompt}}"] },
      "gemini":  { "command": "gemini",  "args": ["--prompt", "{{worker_prompt}}"] }
    },
    "rotation": ["copilot", "codex"],
    "allowCrossAgentFallback": false,
    "providerPolicy": {
      "worker":      { "providers": ["copilot", "codex"],  "allowNativeSubagent": false, "noFallback": false },
      "analyst":     { "providers": ["claude", "codex"],   "allowNativeSubagent": true,  "noFallback": false },
      "librarian":   { "providers": [],                    "allowNativeSubagent": false, "noFallback": true  },
      "finalizer":   { "providers": ["copilot", "codex"],  "allowNativeSubagent": false, "noFallback": false },
      "orchestrator":{ "providers": [],                    "allowNativeSubagent": true,  "noFallback": true  }
    }
  }
}
```

`providers: []` means the role is disabled. Any dispatch targeting it is refused before a packet is written.

---

## 2. Provider Selection Algorithm

`resolveConfigProvider()` in `src/loop/dispatch.ts` currently ignores role. The replacement is `resolveProviderForRole()`.

```
function resolveProviderForRole(role, options):

  1. USER OVERRIDE CHECK
     If options.provider is set (--provider CLI flag):
       a. Validate the provider key exists in execution.providers.
          If not: fail with "provider '<X>' is not defined in execution.providers".
       b. Log provider-selected event with selection_reason: "user-override".
       c. Return { provider: options.provider, mode: "direct-worker", override_source: "user-cli" }.

  2. ROLE POLICY CHECK
     If execution.providerPolicy[role] exists:
       a. Let policy = execution.providerPolicy[role].
       b. If policy.providers is empty:
            Log provider-forbidden event with reason: "role-disabled".
            Fail with "role '<R>' has no configured providers — dispatch refused".
       c. Let candidate = policy.providers[0].
       d. Validate candidate exists in execution.providers.
          If not: fail with "provider '<X>' listed in role policy is not defined".
       e. Log provider-selected event with selection_reason: "role-policy".
       f. Return { provider: candidate, mode: "direct-worker", policy }.

  3. ROTATION FALLBACK
     If execution.rotation has entries:
       a. Let candidate = execution.rotation[0].
       b. Log provider-selected event with selection_reason: "rotation".
       c. Return { provider: candidate, mode: "direct-worker" }.

  4. PROVIDERS MAP FALLBACK
     If execution.providers has keys:
       a. Let candidate = first key.
       b. Log provider-selected event with selection_reason: "config-default".
       c. Return { provider: candidate, mode: "direct-worker" }.

  5. DELEGATED MODE
     No provider configured.
     Return { provider: undefined, mode: "delegated" }.
```

Role is inferred from the worker packet's `role_context.role`. If the packet has not yet been compiled at resolution time, the role is read from cluster-state child metadata.

### Native subagent gate

Before `attemptDelegatedAssignment` calls `getSubagentDispatcher()`, it checks:

```
if role policy exists AND policy.allowNativeSubagent === false:
  skip subagent spawn step entirely
  emit worker-assignment-failed with reason: "native-subagent-not-allowed-for-role"
  proceed to external-process step (or escalation)
```

This prevents the incident pattern: Claude (as current session) routing worker execution back to itself via subagent when the worker role does not allow native dispatch.

---

## 3. Fallback Decision Table

When a provider is selected but unavailable during dispatch:

| Unavailability Cause | Auto-try Next? | When to Stop | When to Ask User |
|---|---|---|---|
| Rate limit / quota exhausted | Yes, if role has next provider in list AND `noFallback: false` | When list exhausted | Always when stopped (emit `provider-exhausted`) |
| Command not found / adapter not installed | **Never** — hard stop | Immediately | Always — user must fix config |
| Provider server unreachable (network) | Yes, if role has next provider AND `noFallback: false` | When list exhausted | When stopped |
| Auth failure / provider refused | **Never** — hard stop | Immediately | Always — credentials issue |
| Provider not allowed for role (forbidden) | **Never** — hard stop | Immediately | Always — governance violation |
| Native subagent failed (exception) | Yes, proceed to external-process step | When all mechanisms exhausted | Via escalation |
| `noFallback: true` for role | **Never** | Immediately after first failure | Always |

"Ask user" means the run transitions to `pending-escalation` and emits an `escalation-initiated` event with a clear `escalation_reason` string. The user sees this in the loop status and can re-dispatch with an explicit `--provider` override.

### Automatic fallback sequence (when allowed)

When a provider fails and auto-fallback is permitted:

```
providers_tried = [initial_provider]
for each next_provider in role_policy.providers[1..]:
  emit provider-fallback-attempted event
  attempt dispatch with next_provider
  if success:
    emit provider-selected event with selection_reason: "fallback"
    record fallback_from, fallback_reason in evidence
    return
  else:
    providers_tried.append(next_provider)

all providers exhausted → pending-escalation
emit provider-exhausted event with providers_tried list
```

---

## 4. User Override Rules

### What is a user override

An override is an explicit user action that selects a specific provider for a dispatch, bypassing the role policy default.

### Override mechanisms (in scope for this design)

1. **`--provider <name>` CLI flag** on `polaris loop dispatch` or `polaris run`.  
   Scoped to the single dispatch call. Not persisted.

2. **Run-local override file** (future, not blocking): `.polaris/runs/<run_id>/provider-override.json`.  
   Allows persisting an override for the remainder of a run without modifying `polaris.config.json`.

### Override invariants

- Override is **validated** against `execution.providers` before use. An unknown provider key fails the dispatch — it does not silently fall through.
- Override does **not** modify `polaris.config.json` or `execution.providerPolicy`. It is local and temporary.
- Override is **logged** in the `provider-selected` telemetry event with `override_source: "user-cli"` or `"user-run-file"`.
- Override is **visible** in the dispatch record (`ChildDispatchRecord.provider_override_source`).
- Override does **not** silence forbidden-provider enforcement when the role policy has `providers: []` (disabled role). A disabled role cannot be unblocked by override; the user must change config.
- Override **may** select a provider not in the role's policy list. This is the whole point — user override bypasses the role default. It is logged as a policy deviation.

### What override does not do

- Does not apply to sibling or future children unless persisted via run-local file with `scope: "run"`.
- Does not modify global defaults visible to other sessions.
- Does not grant the provider permissions beyond what its adapter supports.

---

## 5. Forbidden-Provider Enforcement Rules

### Definition

A provider is forbidden for a role when:

1. `execution.providerPolicy[role]` exists (the role has an explicit policy), **AND**
2. The requested provider is NOT in `providerPolicy[role].providers`.

**OR**

3. `providerPolicy[role].providers` is empty (role is disabled).

When no policy exists for a role, no provider is forbidden for that role — the system falls through to `execution.rotation`.

### Enforcement point

The check runs in `resolveProviderForRole()` **before** the packet is written and before any execution begins. This is the only place the check needs to run because:

- Agents never directly invoke provider commands — they interact with Polaris, which calls dispatch.
- The `--provider` CLI flag is checked against role policy at resolution time.
- Role context is known at dispatch time from the cluster plan and child metadata.

### Enforcement behavior

```
if provider is forbidden for role:
  emit provider-forbidden telemetry event
  fail with error:
    "Provider '<X>' is not allowed for role '<R>'. 
     Allowed providers: [<list>].
     Use --provider with an allowed provider, or update execution.providerPolicy."
  exit — no packet is written, no child is marked dispatched
```

### Agent bypass prevention

Agents may not invoke `claude`, `codex`, or `gemini` commands directly — they operate through Polaris dispatch, which enforces the policy. The `prohibited_actions` list in `WorkerRoleContext` already blocks roles from calling `loop-dispatch` or `dispatch-children`. Extending this to include direct provider CLI invocations requires no new schema — it is a documentation/contract clarification.

The runtime does not need to inspect whether an agent shelled out to a provider command. The boundary is: Polaris owns dispatch. Workers write results and return. Workers do not spawn their own workers.

---

## 6. Provider Decision Evidence Schema

Add the following events to `src/loop/dispatch-state.ts`.

### `provider-selected`

Emitted once per dispatch when a provider is chosen (whether from policy, rotation, or user override).

```typescript
interface ProviderSelectedEvent {
  event: "provider-selected";
  event_id: string;
  dispatch_id: string;
  run_id: string;
  child_id: string;

  /** The role the dispatched child will execute. */
  requested_role: string;

  /** The provider key selected (e.g. "copilot", "claude"). */
  selected_provider: string;

  /** The adapter mode that will be used. */
  selected_adapter: string;

  /**
   * How the selection was made:
   * - "user-override":  explicit --provider flag or run-local override file
   * - "role-policy":    execution.providerPolicy[role].providers[0]
   * - "fallback":       a fallback entry from role policy (providers[1+])
   * - "rotation":       execution.rotation[0] (no role policy)
   * - "config-default": first key in execution.providers (no rotation)
   */
  selection_reason: "user-override" | "role-policy" | "fallback" | "rotation" | "config-default";

  /** Set when selection_reason is "user-override". */
  override_source?: "user-cli" | "user-run-file";

  /** Set when selection_reason is "fallback". */
  fallback_from?: string;

  /** Why the previous provider was unavailable (set when selection_reason is "fallback"). */
  fallback_reason?: string;

  /** All providers tried before this one, in order. */
  providers_tried?: string[];

  timestamp: string;
}
```

### `provider-forbidden`

Emitted when dispatch is refused because the requested provider is not allowed for the role.

```typescript
interface ProviderForbiddenEvent {
  event: "provider-forbidden";
  event_id: string;
  dispatch_id: string;
  run_id: string;
  child_id: string;
  requested_role: string;
  forbidden_provider: string;
  /** "role-disabled" when providers list is empty; "not-in-policy" otherwise. */
  reason: "role-disabled" | "not-in-policy";
  allowed_providers: string[];
  timestamp: string;
}
```

### `provider-fallback-attempted`

Emitted before each fallback attempt (mirrors pattern of `worker-assignment-attempted`).

```typescript
interface ProviderFallbackAttemptedEvent {
  event: "provider-fallback-attempted";
  event_id: string;
  dispatch_id: string;
  run_id: string;
  child_id: string;
  fallback_provider: string;
  fallback_from: string;
  fallback_reason: string;
  attempt_number: number;
  timestamp: string;
}
```

### `provider-exhausted`

Emitted when all providers in the role's list have been tried and failed.

```typescript
interface ProviderExhaustedEvent {
  event: "provider-exhausted";
  event_id: string;
  dispatch_id: string;
  run_id: string;
  child_id: string;
  requested_role: string;
  providers_tried: string[];
  final_failure_reason: string;
  timestamp: string;
}
```

### Addition to `ChildDispatchRecord`

Add these fields to `ChildDispatchRecord` in `src/loop/checkpoint.ts`:

```typescript
/** How the provider was selected for this dispatch. */
provider_selection_reason?: "user-override" | "role-policy" | "fallback" | "rotation" | "config-default";

/** Source of user override, if applicable. */
provider_override_source?: "user-cli" | "user-run-file";

/** Providers tried and skipped before the selected provider. */
providers_tried?: string[];
```

---

## 7. Recommended Implementation Issues

In safe order — each issue is independently mergeable and tested without breaking the previous.

### POL-258 — Extend `RoleProviderPolicy` in config schema

**Scope**: `src/config/schema.ts`, `src/config/schema.json`, schema validator tests.

Add `RoleProviderPolicy` interface and `providerPolicy` field to `ExecutionConfig`. No runtime behavior change — schema-only. Update validator to accept and typecheck the new shape. Add a test config fixture with role policies.

**Safe because**: Pure additive schema change. No existing behavior is altered.

---

### POL-259 — Role-aware provider resolution in dispatch

**Scope**: `src/loop/dispatch.ts`, `src/config/loader.ts`.

Replace `resolveConfigProvider()` with `resolveProviderForRole(role, options)` as specified in section 2. Wire role lookup from the worker packet's `role_context.role` (packet is built before provider resolution, so this is available). Add unit tests covering: no policy (falls through to rotation), policy present (uses providers[0]), user override (bypasses policy).

**Safe because**: Behavior change is gated by presence of `execution.providerPolicy` in config. Configs without a `providerPolicy` section behave identically to today.

---

### POL-260 — Native subagent role gate

**Scope**: `src/loop/dispatch.ts` (`attemptDelegatedAssignment`).

Before calling `getSubagentDispatcher()`, check `providerPolicy[role].allowNativeSubagent`. If false, skip subagent step and emit `worker-assignment-failed` with reason `"native-subagent-not-allowed-for-role"`. This prevents unintended same-session worker dispatch for roles that should use external providers.

**Safe because**: Only blocks subagent dispatch when the policy explicitly sets `allowNativeSubagent: false`. Omitting the policy leaves behavior unchanged.

---

### POL-261 — Forbidden provider enforcement

**Scope**: `src/loop/dispatch.ts` (pre-dispatch validation), `src/loop/dispatch-state.ts` (new event types).

Add `assertProviderAllowedForRole()` called in `runLoopDispatch` after role resolution and before `writePacketArtifact`. Emit `provider-forbidden` telemetry and fail with a clear error message. Also emit `provider-selected` event on the success path.

**Safe because**: Only fires when `execution.providerPolicy[role]` is defined. Existing deploys with no `providerPolicy` skip the check entirely.

---

### POL-262 — Provider decision evidence logging

**Scope**: `src/loop/dispatch-state.ts`, `src/loop/checkpoint.ts`, `src/loop/dispatch.ts`.

Add all four event types defined in section 6. Emit `provider-selected` and `provider-fallback-attempted` from the new resolution logic. Add the three new fields to `ChildDispatchRecord`. Update dispatch tests to assert telemetry output.

**Safe because**: Purely additive — new event types and new optional fields on an existing record type.

---

### POL-263 — Recommended default provider policy in config

**Scope**: `polaris.config.json`, documentation update to this spec.

Update the working `polaris.config.json` with a `providerPolicy` section matching the defaults recommended in section 1:

- `worker`: copilot (default), codex (fallback), no native subagent.
- `analyst`: claude (default), codex (fallback), native subagent allowed.
- `librarian`: disabled (empty providers list).
- `orchestrator`/`finalizer`: empty providers list (dispatches via polaris CLI, not external agent).

This makes the incident pattern (Claude used as worker without authorization) impossible by config.

**Safe because**: A user deploying this default is explicitly opting in by applying the config. No existing behavior is forced to change.

---

## Relationship to existing schema fields

| Existing field | Status after this design |
|---|---|
| `execution.rotation` | Retained as fallback when no `providerPolicy` for role. |
| `execution.allowCrossAgentFallback` | Retained but now superseded per-role by `providerPolicy[role].noFallback`. Recommend deprecating in a future cleanup issue. |
| `execution.roles[role].provider` | Retained for adapter/model/command override. `providerPolicy` governs the allowed-list; `roles[role].provider` is a convenience alias for `providerPolicy[role].providers[0]` when no full policy is needed. These are not merged — `providerPolicy` takes precedence when both are present. |
| `skill_packet.allow_cross_provider_delegation` | Retained for analysis packet context. Not related to dispatch-time provider governance. |

---

## Acceptance criteria mapping

| Acceptance criterion (from POL-256) | Design element |
|---|---|
| Polaris, not agents, owns provider selection | Section 2: `resolveProviderForRole()` is called by Polaris dispatch, not by agent instructions |
| Each role can define an ordered provider list | Section 1: `RoleProviderPolicy.providers[]` |
| Default and fallback behavior are explicit | Section 3: fallback decision table + section 2: selection algorithm |
| User override is explicit and auditable | Section 4: `--provider` flag + `override_source` in evidence |
| Providers not allowed for a role cannot be used | Section 5: `assertProviderAllowedForRole()` + `provider-forbidden` event |
| Prevents surprise Claude/Gemini usage for worker | Section 7 POL-263: default policy sets worker to copilot/codex only |
| Output small enough for Codex to implement | Section 7: six bounded issues, each independently testable |
