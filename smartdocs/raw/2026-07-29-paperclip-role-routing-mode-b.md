# Patch: Paperclip Mode B Role-Aware Routing for Polaris

## Context

Polaris-CLO currently routes all Paperclip dispatches through a single flat `execution.paperclip.assigneeAgentId`. This is mode A. We need mode B: per-role routing where:
- Roles with exactly one capable agent auto-assign
- Roles with multiple capable agents defer to the Paperclip issue's `assigneeAgentId` (the foreman's explicit pick)
- The foreman must assign the issue before Polaris dispatches to a multi-agent role

The adapter registry and Paperclip adapter already support `paperclip` as an execution adapter. The gap is in `parent.ts` (which short-circuits provider resolution for paperclip) and the config schema (which lacks `roleRegistry`).

## Team Configuration

Use these exact agent IDs. They come from Paperclip's own `/api/companies/{id}/agents` response.

| Polaris Role | Paperclip Agent | ID | reportsTo |
|--------------|-----------------|----|-----------|
| foreman | River | `7e7e6e43-505e-4edb-bf6b-7cb54aab261c` | Cove |
| worker | Alex | `b3caa4b2-0578-40ee-8042-42bffd6fcb5c` | River |
| worker | Gwyn | `9143ed5c-8356-43b8-9b4d-035cbfcf5793` | River |
| worker | Aria | `39f35fc9-5434-4226-83e3-a435809aac81` | River |
| worker | Riley | `42c3576f-94ac-427e-b4a8-ced4d1167687` | River |
| medic | Kira | `98f310f0-1062-48a3-b02f-6dae833859fb` | River |
| librarian | Sage | `af226c67-3541-45ba-839a-b2fafb4ea75c` | Cove |
| qc | CodeRabbit (CLI tool, not Paperclip agent) | N/A | — |

### QC handling

CodeRabbit is a CLI provider, not a Paperclip agent. The `qc` Paperclip role should initialize with an empty array. If a foreman wants a Paperclip issue for QC work, they assign it manually and Polaris honors that choice. Fallback `assigneeAgentId` (if set) is only used when no QC Paperclip agents exist.

## Files to Modify

### 1. `src/loop/parent.ts`

**Locate the block at approximately line 968:**

```typescript
} else if (adapterName === "paperclip" && config.execution?.paperclip?.assigneeAgentId) {
  const assigneeAgentId = config.execution.paperclip.assigneeAgentId;
  providerName = assigneeAgentId;
  providerSelectionReason = "paperclip-assignee";
  providersTried = [assigneeAgentId];
  routingSummary = {
    selected_provider: assigneeAgentId,
    selected_adapter: "paperclip",
    selection_reason: "paperclip-assignee",
    effective_policy_order: [assigneeAgentId],
    compatibility_mode: false,
    registry_present: false,
    fallback_eligible: false,
  };
}
```

**Replace with:**

```typescript
} else if (adapterName === "paperclip") {
  // Resolve role from state.worker_role or state.role; default to "worker"
  const dispatchRole =
    typeof state === "object" && state !== null
      ? (state as any).worker_role ?? (state as any).role ?? "worker"
      : "worker";
  const pc = config.execution?.paperclip;
  const roleRegistry = (pc?.roleRegistry as Record<string, string[]> | undefined) ?? {};
  const candidates = roleRegistry[dispatchRole] ?? [];
  const assigneeAgentId = pc?.assigneeAgentId;

  let resolvedAssignee: string | undefined;
  let selectionReason: string;

  if (candidates.length === 1) {
    // Singleton role: auto-assign to the one capable agent
    resolvedAssignee = candidates[0];
    selectionReason = "paperclip-role-auto";
  } else if (candidates.length > 1) {
    // Multi-agent role: require the foreman to have made an explicit
    // assignee pick on the Paperclip issue. Polaris must honor that pick.
    const issueAssignee = pc?.assigneeAgentId;
    if (!issueAssignee) {
      return {
        haltReason: "config-missing",
        childrenDispatched: 0,
        message: `Paperclip role "${dispatchRole}" has multiple capable agents (${candidates.join(", ")}), but no assigneeAgentId is set on the issue. The foreman must explicitly assign the issue before Polaris dispatches.`,
      };
    }
    if (!candidates.includes(issueAssignee)) {
      return {
        haltReason: "config-invalid",
        childrenDispatched: 0,
        message: `Paperclip issue assignee ${issueAssignee} is not in roleRegistry["${dispatchRole}"] (${candidates.join(", ")}). The foreman's pick must be one of the role's capable agents.`,
      };
    }
    resolvedAssignee = issueAssignee;
    selectionReason = "paperclip-foreman-pick";
  } else {
    // Role not in registry and no fallback assignee configured
    if (assigneeAgentId) {
      resolvedAssignee = assigneeAgentId;
      selectionReason = "paperclip-fallback";
    } else {
      return {
        haltReason: "config-missing",
        childrenDispatched: 0,
        message: `No Paperclip agent configured for role "${dispatchRole}". Add execution.paperclip.roleRegistry["${dispatchRole}"] or set execution.paperclip.assigneeAgentId.`,
      };
    }
  }

  providerName = resolvedAssignee;
  providerSelectionReason = selectionReason;
  providersTried = [resolvedAssignee];
  routingSummary = {
    selected_provider: resolvedAssignee,
    selected_adapter: "paperclip",
    selection_reason: selectionReason,
    effective_policy_order: [resolvedAssignee],
    compatibility_mode: false,
    registry_present: true,
    fallback_eligible: false,
  };
}
```

### 2. `src/config/schema.ts`

Add to `PaperclipExecutionConfig` (after `targetPaths?`):

```typescript
/**
 * Map of Polaris worker role to the list of Paperclip agent UUIDs capable
 * of fulfilling that role.
 *
 * - 1 entry: Polaris auto-assigns that agent.
 * - >1 entries: Polaris requires the Paperclip issue's `assigneeAgentId`
 *   to be one of the listed agents (foreman's explicit pick).
 * - 0 entries: falls back to `assigneeAgentId` or halts with a config error.
 */
roleRegistry?: Record<string, string[]>;
```

### 3. `src/config/schema.json`

Regenerate from `schema.ts` if possible. As a fallback, under `"paperclipExecutionConfig"` add:

```json
"roleRegistry": {
  "type": "object",
  "description": "Map of Polaris worker role to allowed Paperclip agent UUIDs.",
  "additionalProperties": {
    "type": "array",
    "items": { "type": "string" }
  }
}
```

Leave `assigneeAgentId` in `required` for backward compatibility.

### 4. `src/config/validator.ts`

After the existing `paperclip` block (after `timeoutMs` check), add:

```typescript
if ("roleRegistry" in paperclip && paperclip.roleRegistry && typeof paperclip.roleRegistry === "object") {
  const validRoles = new Set<string>([
    "foreman",
    "worker",
    "librarian",
    "medic",
    "qc",
    "repair",
    "startup",
    "preflight",
    "finalize",
    "analyze",
  ]);
  const registry = paperclip.roleRegistry as Record<string, unknown>;
  for (const [key, value] of Object.entries(registry)) {
    if (!validRoles.has(key)) {
      result.errors.push(`execution.paperclip.roleRegistry has invalid role key: ${key}. Valid keys: ${Array.from(validRoles).join(", ")}.`);
    }
    if (!Array.isArray(value)) {
      result.errors.push(`execution.paperclip.roleRegistry["${key}"] must be an array of agent UUID strings.`);
      continue;
    }
    const seen = new Set<string>();
    for (const agentId of value) {
      if (typeof agentId !== "string" || !/^[0-9a-f-]{36}$/i.test(agentId)) {
        result.errors.push(`execution.paperclip.roleRegistry["${key}"] contains non-UUID value: ${String(agentId)}`);
      }
      if (seen.has(agentId)) {
        result.errors.push(`execution.paperclip.roleRegistry["${key}"] contains duplicate agent: ${agentId}`);
      }
      seen.add(agentId);
    }
  }
}
```

## Behavior Contract

### Role resolution order
1. `execution.paperclip.roleRegistry[<current_role>]` is the source of truth for who can fulfill a role
2. If the registry returns exactly 1 agent for the current role → auto-assign, `selection_reason: "paperclip-role-auto"`
3. If the registry returns >1 agents → use `execution.paperclip.assigneeAgentId` from the Paperclip issue body/config. If it's missing, halt dispatch with a clear message telling the foreman to assign. If it's set but not in the registry, halt with an invalid-assignee message
4. If the registry returns 0 agents → fall back to flat `execution.paperclip.assigneeAgentId`. If that's also missing, halt with a config error

### Foreman behavior
- For singleton roles, the foreman does not need to assign — Polaris auto-binds
- For multi-agent roles (currently: `worker`, `qc` if populated), the foreman must explicitly set the Paperclip issue's `assigneeAgentId` before Polaris dispatches. Polaris honors that pick and does not override it with provider rotation or fallback logic

### Backward compatibility
- Existing configs with only `execution.paperclip.assigneeAgentId` and no `roleRegistry` behave exactly as before: all Paperclip dispatches go to the flat assignee
- `roleRegistry` is additive. An empty registry or missing registry is not an error as long as `assigneeAgentId` is present

### Config shape for this team
Use this exact config in `polaris.config.json`:

```json
{
  "version": "1.0",
  "execution": {
    "adapter": "paperclip",
    "routerPolicy": {
      "defaultWorkerPool": {
        "maxActiveWorkers": 1,
        "maxActiveSlots": 1
      },
      "allowCrossProviderFallback": false,
      "parallelPaperclip": false
    },
    "paperclip": {
      "baseUrl": "http://127.0.0.1:3100",
      "companyId": "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
      "tokenEnv": "PAPERCLIP_API_KEY",
      "runIdEnv": "POLARIS_RUN_ID",
      "pollIntervalMs": 2000,
      "timeoutMs": 1200000,
      "repoUrl": "file:///home/hermes/Developer/LSCT-Homebase",
      "workingDirectory": "/home/hermes/Developer/LSCT-Homebase",
      "roleRegistry": {
        "foreman":   ["7e7e6e43-505e-4edb-bf6b-7cb54aab261c"],
        "worker":    ["b3caa4b2-0578-40ee-8042-42bffd6fcb5c", "9143ed5c-8356-43b8-9b4d-035cbfcf5793", "39f35fc9-5434-4226-83e3-a435809aac81", "42c3576f-94ac-427e-b4a8-ced4d1167687"],
        "librarian": ["af226c67-3541-45ba-839a-b2fafb4ea75c"],
        "medic":     ["98f310f0-1062-48a3-b02f-6dae833859fb"],
        "qc":        []
      },
      "assigneeAgentId": "7e7e6e43-505e-4edb-bf6b-7cb54aab261c"
    }
  },
  "tracker": {
    "adapter": "linear",
    "linear": {
      "teamId": "Polaris",
      "projectId": "Polaris Core Runtime",
      "enabled": true
    }
  },
  "orchestration": {
    "mode": "supervised"
  },
  "providers": {
    "repoAnalysis": {
      "preferred": "polaris-graph"
    }
  }
}
```

## Tests to Update/Add

1. **`src/loop/parent.test.ts`** around line 1345 — extend the paperclip branch to cover:
   - Single-agent role auto-assignment
   - Multi-agent role with explicit foreman assignee → honor it
   - Multi-agent role with no issue assignee → halt with clear message
   - Role not in registry → fallback to `assigneeAgentId`
   - No registry and no fallback → halt with config error

2. **`src/config/validator.test.ts`** — add:
   - Happy path: valid `roleRegistry` with UUID arrays
   - Reject invalid role key
   - Reject non-UUID values
   - Reject duplicate entries within an array
   - Empty arrays are valid (they mean “no Paperclip agent for this role”)

## Verification Steps

After patching, run from `/home/hermes/Developer/projects/Polaris-CLO`:

```bash
npm run build
npm test -- --grep "paperclip\|parent"
```

Then from `/home/hermes/Developer/LSCT-Homebase`:

```bash
export PAPERCLIP_API_KEY=$(python3 -c "import json; print(json.load(open('/home/hermes/.paperclip/auth.json'))['credentials']['http://127.0.0.1:3100']['token'])")
export LINEAR_API_KEY="<redacted-see-your-linear-api-key-store>"
polaris status
```

Expected: Polaris config loads without errors. No Paperclip dispatch happens until a run is active.
