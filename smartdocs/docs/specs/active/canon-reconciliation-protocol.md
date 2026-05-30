---
kind: spec
status: active
source: POL-50
created: 2026-05-23
implements: 
related: 
supersedes: 
superseded_by: 
depends_on: 
validates: 
source_paths: src/smartdocs-engine/canon-check.ts
---

# Canon Reconciliation Check Protocol

**Status:** active spec
**Issue:** POL-50 (child of POL-42)
**Created:** 2026-05-23

---

## 1. Purpose

This spec defines the canon reconciliation check protocol — the algorithm every `polaris loop continue` and `polaris finalize` invocation uses to detect divergence from current canon before proceeding.

The protocol answers a single question before allowing session work to continue or finalize:

> Does the proposed work align with the current authoritative state of this repo, or does it contradict, supersede, or lag behind what canon currently says?

---

## 2. Canon Definition

"Canon" in a Polaris-managed repo is the union of three source types, in descending authority order:

| Layer | Files | Authority |
|---|---|---|
| **Instruction files** | All `POLARIS.md` files in the repo (any directory) | High — governs editing rules and architecture assumptions for their directory and children |
| **Active doctrine** | `docs/doctrine/active/*.md` | High — approved behavioral assertions; may only be changed by explicit user approval |
| **Active and implemented specs** | `docs/specs/active/*.md`, `docs/specs/implemented/*.md` | Medium — governs current and completed work; superseding requires user approval |

Files in `docs/doctrine/candidate/`, `docs/doctrine/raw/`, `docs/specs/raw/`, `docs/specs/superseded/`, and all `docs/runtime/` subdirectories are **not canon**. They carry no authority for the reconciliation check.

---

## 3. Check Algorithm

### 3.1 Inputs

| Input | Source |
|---|---|
| Proposed work scope | Child issue scope from `current-state.json` (`open_children_meta[child_id]`) |
| Files to be changed | Bootstrap packet `changed_files` list or (in finalize) `git diff --name-only HEAD~1` |
| Repo root | `repoRoot` from invocation options |

### 3.2 Step 1 — Locate Relevant Canon Files

For each changed file path:

1. Find the nearest `POLARIS.md` in the file's directory or any ancestor directory (walk upward; stop at repo root).
2. Add all `docs/doctrine/active/*.md` files.
3. Add all `docs/specs/active/*.md` and `docs/specs/implemented/*.md` files whose front-matter `scope` field (if present) overlaps the directory or domain being changed, OR whose filename contains a keyword matching the changed file's domain (`loop`, `map`, `finalize`, `config`, `cli`, `docs`).

Deduplication: each canon file is inspected once even if matched by multiple changed files.

### 3.3 Step 2 — Compare Proposed Changes Against Canon

For each canon file, extract the following elements for comparison:

- **Editing rules** (from `POLARIS.md` `## Editing rules` section)
- **Architecture assumptions** (from `POLARIS.md` `## Architecture assumptions` section)
- **Behavioral assertions** (from doctrine files — any declarative statement of the form "X must Y", "X always Z", "X never W")
- **Scope claims** (from spec files — what the spec says is implemented or governs)

Compare each element against:
- The issue scope description (from the child issue text)
- The list of files proposed to be changed

Comparison is semantic: look for direct contradiction (the proposed change would violate an editing rule or architecture assumption), scope overlap (the proposed spec conflicts with an active spec's claimed scope), or implementation gap (an active spec says X is implemented but no file matching X exists).

### 3.4 Step 3 — Classify Outcome

Assign exactly one outcome from the taxonomy in §4.

---

## 4. Outcome Taxonomy

### `aligned`

**Condition:** The proposed work matches or extends canon without contradiction. No editing rules are violated. No active doctrine assertions are contradicted. No active spec scope is claimed to be superseded.

**Resolution:** Proceed normally.

### `candidate-divergence`

**Condition:** The proposed work differs from what canon describes, but the difference is expected and approved — e.g., the issue explicitly calls for updating a spec, adding new doctrine, or changing behavior described in an existing spec, and that change is reflected in the issue scope.

**Resolution:** Agent may write to `docs/doctrine/candidate/` or `docs/specs/raw/` to propose updated canon. Proceed with warning emitted to telemetry. The agent must NOT promote directly to `docs/doctrine/active/` or `docs/specs/active/`.

### `stale-implementation`

**Condition:** An active spec or active doctrine file asserts that something (a command, a field, a file, a behavior) exists or is required, but the implementation shows it is absent, broken, or materially different from what canon describes.

Examples:
- `docs/specs/active/foo.md` says command `polaris foo bar` exists; no such command is found in `src/`.
- A `POLARIS.md` `## Architecture assumptions` entry says "state writes use `checkpoint.ts`"; proposed change would write state directly.

**Resolution:** Halt. Report the specific gap. Require explicit user approval before proceeding. Do not generate a bootstrap packet or create a PR until the gap is resolved or the user overrides.

### `stale-docs`

**Condition:** The implementation has changed (or the proposed change would change it) in a way that makes existing canon descriptions outdated, but there is no direct contradiction — the canon just no longer accurately describes what the implementation does.

Examples:
- A `POLARIS.md` lists a file that no longer exists.
- An active spec describes a 3-step finalize flow; finalize now has 12 steps.

**Resolution:** Agent may flag the stale doc and add it to the `docs/raw/` ingest queue (write a stub or note in `docs/raw/`) without halting. Emit `stale-docs` warning to telemetry. Proceed with warning.

---

## 5. Conflict Surface Protocol

| Outcome | Action | Exit behavior |
|---|---|---|
| `aligned` | Proceed | Normal continuation or finalize |
| `candidate-divergence` | Write candidate docs to `docs/doctrine/candidate/` or `docs/specs/raw/`; emit `canon-check-result` with `outcome: candidate-divergence`; proceed with warning | Non-blocking; continue or finalize proceeds |
| `stale-implementation` | Emit `canon-conflict-halt` event; print structured conflict report to stderr; halt | Exit non-zero; block PR creation |
| `stale-docs` | Write stub to `docs/raw/` flagging the stale doc; emit `canon-check-result` with `outcome: stale-docs`; proceed with warning | Non-blocking; continue or finalize proceeds |

The conflict report for `stale-implementation` must include:
- The canon file path that contains the conflicting assertion
- The exact statement from that file that is violated
- The specific file or behavior that is missing or differs
- A suggested resolution path (update the canon, implement the missing piece, or request override)

Polaris must never silently suppress a `stale-implementation` conflict.

---

## 6. Approval Boundary

### Agent MAY (without user input)

- Write to `docs/doctrine/candidate/` — propose new or updated doctrine for review
- Write to `docs/specs/raw/` — drop a new or updated spec for review
- Write stubs to `docs/raw/` — flag stale docs for ingest
- Add `stale-docs` and `candidate-divergence` warnings to telemetry
- Generate a bootstrap packet after a `candidate-divergence` or `stale-docs` outcome

### Agent MUST STOP FOR USER

- Promoting anything from `docs/doctrine/candidate/` to `docs/doctrine/active/` — this requires `polaris doctrine promote` (POL-52)
- Superseding an active spec — moving from `docs/specs/active/` to `docs/specs/superseded/`
- Removing or modifying content in `docs/doctrine/active/` or `docs/specs/active/` without being explicitly tasked to do so
- Removing or overwriting any `POLARIS.md` section without being explicitly tasked
- Continuing or finalizing when outcome is `stale-implementation`

The boundary is defined by authority level: agents own candidate and raw; users own active and architecture.

---

## 7. Integration Points

### 7.1 `polaris loop continue`

**When:** Before building the bootstrap packet (before Step 4 in `continue.ts`).

**Inputs read:**
- `current-state.json` — for `open_children_meta[next_child]` scope and `changed_files`
- Canon files located per §3.2

**Steps inserted between current Step 3 (map update) and Step 4 (boundary check):**

```
Step 3.5 (new): Canon reconciliation check
  - Locate canon files for next child's scope
  - Run check algorithm (§3)
  - Classify outcome
  - If outcome == stale-implementation:
      emit canon-conflict-halt event
      print conflict report to stderr
      exit non-zero
  - Otherwise:
      emit canon-check-result event
      if candidate-divergence or stale-docs: write draft docs, emit warning
      proceed to Step 4
```

**Emits:** `canon-check-start`, `canon-check-result`, or `canon-conflict-halt` (see §8).

**Exit behavior:** `stale-implementation` exits non-zero before any bootstrap packet is written. All other outcomes allow the packet to be written normally.

### 7.2 `polaris finalize`

**When:** After Step 4 (run checks) and before Step 5 (generate report) in `finalize/index.ts`.

**Inputs read:**
- All files changed in the run: `git diff --name-only <base-branch>...HEAD`
- Canon files located per §3.2 for those changed files
- `current-state.json` — for `cluster_id` and `run_id`

**Steps inserted between current Step 4 and Step 5:**

```
Step 4.5 (new): Canon reconciliation check
  - Locate canon files for all run-changed files
  - Run check algorithm (§3)
  - Classify outcome
  - If outcome == stale-implementation:
      emit canon-conflict-halt event
      print conflict report to stderr
      block PR creation (exit before Step 8)
      exit non-zero
  - Otherwise:
      emit canon-check-result event
      if candidate-divergence or stale-docs: write draft docs, emit warning
      proceed to Step 5
```

**Emits:** `canon-check-start`, `canon-check-result`, or `canon-conflict-halt` (see §8).

**Exit behavior:** `stale-implementation` halts before Step 5 and blocks PR creation. All other outcomes allow finalize to proceed normally.

---

## 8. Telemetry Events

All events include `event`, `run_id`, and `timestamp` as required fields, consistent with existing Polaris telemetry conventions.

### `canon-check-start`

Emitted at the beginning of the check, before any file is inspected.

```json
{
  "event": "canon-check-start",
  "run_id": "<run-id>",
  "child_id": "<child-issue-id or null for finalize>",
  "canon_files_inspected": 3,
  "changed_files_count": 5,
  "timestamp": "<ISO>"
}
```

### `canon-check-result`

Emitted after the outcome is classified.

```json
{
  "event": "canon-check-result",
  "run_id": "<run-id>",
  "child_id": "<child-issue-id or null>",
  "outcome": "aligned | candidate-divergence | stale-implementation | stale-docs",
  "conflicts": [
    {
      "type": "candidate-divergence | stale-implementation | stale-docs",
      "canon_file": "docs/doctrine/active/foo.md",
      "statement": "The exact conflicting statement from canon",
      "changed_file": "src/loop/continue.ts",
      "detail": "Human-readable description of the conflict"
    }
  ],
  "timestamp": "<ISO>"
}
```

`conflicts` is an empty array when outcome is `aligned`.

### `canon-conflict-halt`

Emitted only when outcome is `stale-implementation` and the protocol halts execution.

```json
{
  "event": "canon-conflict-halt",
  "run_id": "<run-id>",
  "child_id": "<child-issue-id or null>",
  "reason": "Human-readable summary of why the halt was triggered",
  "canon_file": "docs/specs/active/bar.md",
  "conflicting_statement": "The exact statement from the canon file that is violated",
  "missing_or_differing": "Description of what the implementation lacks or differs from",
  "suggested_resolution": "Update canon, implement missing piece, or request override",
  "timestamp": "<ISO>"
}
```

---

## 9. Implementation Notes for POL-51

This section is guidance for the implement child (POL-51) to proceed without further design decisions.

### File locations

- Canon check logic: `src/loop/canon-check.ts` (new file)
- Integration in loop: `src/loop/continue.ts` — insert call between map update and boundary check
- Integration in finalize: `src/finalize/index.ts` — insert call between Step 4 and Step 5
- Tests: `src/loop/canon-check.test.ts`

### Function signatures (recommended)

```typescript
export type CanonOutcome =
  | "aligned"
  | "candidate-divergence"
  | "stale-implementation"
  | "stale-docs";

export interface CanonConflict {
  type: Exclude<CanonOutcome, "aligned">;
  canonFile: string;
  statement: string;
  changedFile: string;
  detail: string;
}

export interface CanonCheckResult {
  outcome: CanonOutcome;
  conflicts: CanonConflict[];
  canonFilesInspected: number;
}

export interface CanonCheckOptions {
  repoRoot: string;
  changedFiles: string[];
  childId?: string;  // undefined for finalize invocation
  runId: string;
  telemetryFile: string;
}

export function runCanonCheck(options: CanonCheckOptions): CanonCheckResult;
```

`runCanonCheck` is synchronous and pure (no side effects) except for telemetry appends. It returns the result; callers decide how to act on it.

### Semantic comparison strategy

For the initial implementation (POL-51), content comparison should use keyword extraction rather than full semantic reasoning:

1. Parse `## Editing rules` and `## Architecture assumptions` sections from `POLARIS.md` as a list of bullet points.
2. Check if any changed file is specifically named in a rule (e.g., "state writes must use `checkpoint.ts`") and the change would route around that file.
3. For doctrine and spec files: extract sentences containing modal verbs (must, never, always, should, required) and check for keyword overlap with changed file paths.
4. Flag as `stale-implementation` only when there is a named, specific assertion that is clearly not satisfied — avoid false positives from vague guidance.
5. When in doubt, classify as `aligned` with a `stale-docs` note rather than halting.

The goal is zero false halts in normal operation. `stale-implementation` halts should be rare and unambiguous.

### Draft doc creation for candidate-divergence and stale-docs

When writing drafts:
- `candidate-divergence`: create `docs/doctrine/candidate/<slug>-<date>.draft.md` with front-matter `status: candidate`, `source: <canon-file>`, `proposed-by: <child-id>`, `proposed-at: <ISO>`.
- `stale-docs`: create `docs/raw/stale-flag-<slug>-<date>.md` with a brief note: which canon file appears stale, which changed file triggered the flag, and what appears to be outdated.

---

## 10. Success Criteria

This spec is complete when:

- POL-51 can implement the check using only this spec without further design decisions
- `polaris loop continue` blocks on `stale-implementation` and proceeds for all other outcomes
- `polaris finalize` blocks PR creation on `stale-implementation` and proceeds for all other outcomes
- Telemetry events `canon-check-start`, `canon-check-result`, `canon-conflict-halt` are emitted correctly
- The approval boundary (§6) is honored: agents never promote to active canon without user input
- No false halts for normal aligned work
