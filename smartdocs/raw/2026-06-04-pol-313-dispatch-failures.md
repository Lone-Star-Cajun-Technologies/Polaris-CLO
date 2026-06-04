# POL-313 Dispatch Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four root causes that made the POL-313 polaris-run use native subagent spawn instead of the configured terminal-cli adapter (copilot/codex), produce malformed worker result files, and dispatch the closeout librarian with a bare packet path.

**Architecture:** Four surgical fixes across three files and one config: (1) remove duplicate `orchestrator` key from `polaris.config.json`, (2) fix the delegation note in the skill packet generator so `allow_cross_provider_delegation: false` tells the orchestrator to use the terminal-cli adapter instead of native subagents, (3) fix the `SealedWorkerResult.status` type and embed a result-file template in `SealedResultFileContract` so workers know exactly what to write, and (4) add explicit librarian dispatch message framing to `chain.md` so the orchestrator never sends a bare packet path.

**Tech Stack:** TypeScript, Vitest, Node.js

---

## File Map

| File | Change |
|------|--------|
| `polaris.config.json` | Remove duplicate `orchestrator` key |
| `src/skill-packet/generator.ts` | Fix delegation note for `allow_cross_provider_delegation: false` |
| `src/skill-packet/generator.test.ts` | Add tests for delegation note content |
| `src/loop/worker-packet.ts` | Add `"done"` to `SealedWorkerResult.status`; add `result_required_fields` to `SealedResultFileContract` |
| `.polaris/skills/polaris-run/chain.md` | Add librarian dispatch message template to step 08 |

---

## Task 1: Fix duplicate `orchestrator` key in `polaris.config.json`

**Files:**
- Modify: `polaris.config.json`

The config currently has two `"orchestrator"` entries in `providerPolicy`. JSON parsers take the last value, so `allowNativeSubagent: true` wins, overriding the intended `false`. This lets Codex call `spawn_agent` natively.

- [ ] **Step 1: Remove the second (incorrect) `orchestrator` entry**

Open `polaris.config.json`. The `providerPolicy` block currently looks like:

```json
"providerPolicy": {
  "worker": {
    "providers": ["copilot", "codex"],
    "allowNativeSubagent": false
  },
  "orchestrator": {
    "providers": ["codex", "copilot"],
    "allowNativeSubagent": false
  },
  "analyst": {
    "providers": ["claude", "codex"],
    "allowNativeSubagent": true
  },
  "librarian": {
    "providers": ["gemini","claude","codex","copilot"]
  },
  "orchestrator": {
    "providers": [],
    "allowNativeSubagent": true
  },
  "finalizer": {
    "providers": ["copilot"]
  }
}
```

Delete the second `"orchestrator"` block (the one with `"providers": []` and `"allowNativeSubagent": true`). Final `providerPolicy` must be:

```json
"providerPolicy": {
  "worker": {
    "providers": ["copilot", "codex"],
    "allowNativeSubagent": false
  },
  "orchestrator": {
    "providers": ["codex", "copilot"],
    "allowNativeSubagent": false
  },
  "analyst": {
    "providers": ["claude", "codex"],
    "allowNativeSubagent": true
  },
  "librarian": {
    "providers": ["gemini","claude","codex","copilot"]
  },
  "finalizer": {
    "providers": ["copilot"]
  }
}
```

- [ ] **Step 2: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('polaris.config.json','utf8')); console.log('valid')"
```

Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add polaris.config.json
git commit -m "fix(config): remove duplicate orchestrator key that enabled native subagent spawn"
```

---

## Task 2: Fix skill packet delegation note

**Files:**
- Modify: `src/skill-packet/generator.ts`
- Modify: `src/skill-packet/generator.test.ts`

`buildRunPacket` currently maps `allow_cross_provider_delegation: false` to the message "Use internal child/subagent fallback only." This is backwards — it should tell the orchestrator to use the terminal-cli adapter with configured providers, not to use native subagents.

- [ ] **Step 1: Write failing test in `src/skill-packet/generator.test.ts`**

Add inside the existing `describe("generateSkillPacket", ...)` block:

```typescript
describe("run packet delegation note", () => {
  it("when allow_cross_provider_delegation is false, tells orchestrator to use terminal-cli adapter", () => {
    const packet = generateSkillPacket("run", {
      ...DEFAULT_CONFIG,
      allow_cross_provider_delegation: false,
    });
    const note = packet.authority_boundaries.find((b) => b.startsWith("Delegation policy:"));
    expect(note).toBeDefined();
    expect(note).toContain("terminal-cli adapter");
    expect(note).not.toContain("internal child/subagent fallback");
  });

  it("when allow_cross_provider_delegation is true, permits cross-provider delegation", () => {
    const packet = generateSkillPacket("run", {
      ...DEFAULT_CONFIG,
      allow_cross_provider_delegation: true,
    });
    const note = packet.authority_boundaries.find((b) => b.startsWith("Delegation policy:"));
    expect(note).toBeDefined();
    expect(note).toContain("permitted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/skill-packet/generator.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — "terminal-cli adapter" not found in delegation note.

- [ ] **Step 3: Fix `buildRunPacket` in `src/skill-packet/generator.ts`**

Change the `delegationNote` assignment from:

```typescript
const delegationNote = config.allow_cross_provider_delegation
  ? "Cross-provider delegation is permitted per configuration."
  : "Cross-provider delegation is NOT permitted. Use internal child/subagent fallback only.";
```

To:

```typescript
const delegationNote = config.allow_cross_provider_delegation
  ? "Cross-provider delegation is permitted per configuration."
  : "Cross-provider delegation is NOT permitted. Use the terminal-cli adapter with configured providers (e.g. copilot, codex). Do not use native subagent spawning.";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/skill-packet/generator.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Build and verify the live packet**

```bash
npm run build && npm run polaris -- skill packet run | python3 -c "import sys,json; p=json.load(sys.stdin); [print(b) for b in p['authority_boundaries'] if 'Delegation' in b]"
```

Expected output contains `terminal-cli adapter` and does NOT contain `internal child/subagent fallback`.

- [ ] **Step 6: Commit**

```bash
git add src/skill-packet/generator.ts src/skill-packet/generator.test.ts
git commit -m "fix(skill-packet): correct delegation note — terminal-cli adapter, not native subagent"
```

---

## Task 3: Fix `SealedWorkerResult` status type and add result-file template

**Files:**
- Modify: `src/loop/worker-packet.ts`

Two problems: (a) `SealedWorkerResult.status` is typed as `"success" | "failure" | "in-progress"` but `continue.ts:98` accepts only `"done" | "success"` — `"done"` is missing from the type, and workers reasonably use it. (b) `SealedResultFileContract` only specifies the path; workers have no template for what to write, causing round-trip schema debugging.

- [ ] **Step 1: Write failing test**

In `src/loop/worker-packet.test.ts` (create if it doesn't exist), add:

```typescript
import { describe, expect, it } from "vitest";
import type { SealedWorkerResult, SealedResultFileContract } from "./worker-packet.js";

describe("SealedWorkerResult", () => {
  it("accepts status: done", () => {
    const result: SealedWorkerResult = {
      run_id: "run-1",
      child_id: "POL-314",
      status: "done",
      commit: "abc1234",
      validation: "passed",
    };
    expect(result.status).toBe("done");
  });
});

describe("SealedResultFileContract", () => {
  it("includes result_required_fields template", () => {
    const contract: SealedResultFileContract = {
      result_file: ".polaris/clusters/POL-313/results/POL-314-abc.json",
      result_required_fields: {
        run_id: "<run_id from packet>",
        cluster_id: "<cluster_id from packet>",
        child_id: "<active_child from packet>",
        status: "done",
        commit: "<git commit sha>",
        validation: "passed",
      },
    };
    expect(contract.result_required_fields).toBeDefined();
    expect(contract.result_required_fields!["status"]).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/loop/worker-packet.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — type error on `status: "done"`, `result_required_fields` does not exist on type.

- [ ] **Step 3: Fix `SealedWorkerResult.status` in `src/loop/worker-packet.ts`**

Find the `SealedWorkerResult` interface (around line 155). Change:

```typescript
status: "success" | "failure" | "in-progress";
```

To:

```typescript
status: "done" | "success" | "failure" | "in-progress";
```

- [ ] **Step 4: Add `result_required_fields` to `SealedResultFileContract`**

Find the `SealedResultFileContract` interface (around line 190). Change from:

```typescript
export interface SealedResultFileContract {
  /**
   * Path where the worker MUST write its SealedWorkerResult.
   * If not present, worker returns compact JSON to stdout (legacy).
   */
  result_file: string;
}
```

To:

```typescript
export interface SealedResultFileContract {
  /**
   * Path where the worker MUST write its SealedWorkerResult.
   * If not present, worker returns compact JSON to stdout (legacy).
   */
  result_file: string;

  /**
   * Required field template. Workers MUST write all of these keys with
   * these exact value shapes into the result_file JSON. Copy values from
   * the sealed packet (run_id, cluster_id, active_child).
   */
  result_required_fields?: Record<string, string>;
}
```

- [ ] **Step 5: Populate `result_required_fields` at packet compile time**

Find the four call sites that build a `SealedResultFileContract` in `src/loop/worker-packet.ts` (around lines 373, 483, 545, 601). Each looks like:

```typescript
result_file_contract: { result_file: input.resultFile },
```

Change each to:

```typescript
result_file_contract: {
  result_file: input.resultFile,
  result_required_fields: {
    run_id: input.runId,
    cluster_id: input.clusterId,
    child_id: input.childId,
    status: "done",
    commit: "<git commit sha of the single implementation commit>",
    validation: "passed",
  },
},
```

Verify the parameter names (`input.runId`, `input.clusterId`, `input.childId`) match the actual input type at each call site — adjust to match if they differ (e.g. `packet.run_id`). Do not guess; read the surrounding context at each site.

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run src/loop/worker-packet.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 7: Run full test suite to check for regressions**

```bash
npm test 2>&1 | tail -30
```

Expected: no new failures (pre-existing failures in `src/finalize/linear.test.ts` and `src/loop/polaris-run-docs.test.ts` are known and out-of-scope).

- [ ] **Step 8: Commit**

```bash
git add src/loop/worker-packet.ts src/loop/worker-packet.test.ts
git commit -m "fix(worker-packet): add 'done' to status type and result_required_fields template"
```

---

## Task 4: Add librarian dispatch message framing to chain.md

**Files:**
- Modify: `.polaris/skills/polaris-run/chain.md`

The orchestrator dispatched the closeout librarian with just a bare packet path as the message. Step 08 in chain.md says "dispatch Closeout Librarian" but gives no message template, so the orchestrator improvised and dropped all framing. The fix is an explicit dispatch message template.

- [ ] **Step 1: Find step 08 in chain.md**

```bash
grep -n "08\|closeout\|librarian" .polaris/skills/polaris-run/chain.md
```

Locate the step 08 row in the step table and the "Closeout Librarian boundary" section.

- [ ] **Step 2: Add dispatch message template to the Closeout Librarian boundary section**

Find the paragraph that says:

```
Step 08 dispatches the Librarian as a bounded session (same model as worker dispatch).
```

Add immediately after it (before the next section heading):

```markdown
**Librarian dispatch message template:**

When dispatching the Closeout Librarian, pass the full message below — NOT just the packet path. Replace `<packet_path>` with the absolute path printed by `npm run polaris -- librarian packet <cluster-id>`:

```
You are the Closeout Librarian for cluster <cluster-id>.

Your sealed packet is at: <packet_path>

Read the packet. Follow the closeout-librarian skill chain. Write your sealed result to the path specified in the packet's `result_path` field. Return only compact JSON: {"role":"closeout-librarian","status":"done","run_id":"<run_id>","cluster_id":"<cluster_id>","dispatch_id":"<dispatch_id>","commit":"<sha>"}.
```

Never dispatch the librarian with only the packet path as the message.
```

- [ ] **Step 3: Verify chain.md renders correctly**

```bash
grep -A 20 "Librarian dispatch message template" .polaris/skills/polaris-run/chain.md
```

Expected: the template block is present and readable.

- [ ] **Step 4: Commit**

```bash
git add .polaris/skills/polaris-run/chain.md
git commit -m "fix(polaris-run): add librarian dispatch message template to prevent bare packet-path dispatch"
```

---

## Task 5: Push all commits to PR 102

- [ ] **Step 1: Verify branch**

```bash
git status && git log --oneline -6
```

Expected: on branch `pol-313-delivery`, all four fix commits visible.

- [ ] **Step 2: Push to remote**

```bash
git push origin pol-313-delivery
```

- [ ] **Step 3: Confirm PR 102 updated**

```bash
gh pr view 102 --json commits --jq '.commits[-4:] | .[].messageHeadline'
```

Expected: all four commit messages appear.
