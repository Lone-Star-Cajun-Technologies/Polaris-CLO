# Polaris Taskchain Authoring Guide

**Target reader:** a future Claude session or human engineer starting a new Polaris cluster from scratch.

For the `chain.yaml` schema reference, see [`taskchain-format.md`](taskchain-format.md).

---

## 1. When to create a cluster

A cluster is the right unit for a **self-contained workstream** that can be completed in 1–3 sessions and produces a coherent deliverable (a working feature, a design spec, a cleanup pass).

**Good cluster scope:**
- Implement a single CLI command end-to-end
- Write and deliver a spec for a new subsystem
- Remove a category of technical debt (e.g. all bootstrap scaffolding)

**Too large:** "Build the entire Polaris runtime." Split into multiple clusters with explicit blockedBy dependencies between them.

**Too small:** "Fix a typo in a doc." A single child cluster adds overhead without benefit — just do the work directly.

**Why bounded clusters beat monolithic work:**
- Session context budget (3 children/session) is enforced automatically — bounded clusters fit naturally
- Each cluster produces a PR with a clear scope, making review tractable
- Blocked work can halt early without stalling unrelated work

---

## 2. Creating the Linear issues

### Parent issue

Create a parent issue with:
- **Title:** `[Cluster N] Short description`
- **Label:** `cluster-parent`
- **Description:** cluster goal, done criteria, and the child list in execution order

### Child issues

Create one child issue per deliverable unit. Each child should be completable in one focused work block (not a vague epic). Use the title format `[CN.X] Child title`.

Each child issue needs:
- **Label:** `cluster-child`
- **Parent:** set to the parent issue
- **Description:** scope, constraints, and clear done criteria
- **`blockedBy` relations:** link to sibling children that must be Done first

**Example child order for a mixed analyze/implement cluster:**

```
POL-31  [C6.1] Design taskchain format      session_type: analyze   blockedBy: []
POL-32  [C6.2] Implement polaris-run        session_type: implement  blockedBy: [POL-31]
POL-33  [C6.3] Implement polaris-analyze    session_type: implement  blockedBy: [POL-31]
POL-34  [C6.4] Remove bootstrap scaffolding session_type: implement  blockedBy: [POL-32, POL-33]
POL-35  [C6.5] Write authoring guide        session_type: implement  blockedBy: [POL-32, POL-33]
```

Children without `blockedBy` dependencies can execute in parallel sessions if needed. Children with `blockedBy` deps wait for their blockers to reach Done status.

---

## 3. Choosing a skill

Two skills exist under `.codex/skills/`:

| Skill | Use when |
|-------|----------|
| `polaris-analyze` | All cluster children are `session_type: analyze` (producing specs, docs, planning) |
| `polaris-run` | All cluster children are `session_type: implement` (writing code, modifying config) |

For **mixed** clusters (analyze children followed by implement children):
1. Start with `polaris-analyze` — it executes the analyze children and halts at the boundary
2. Start a new session with `polaris-run` for the implement children

You never mix skills within a single session. The `analyzeImplBoundaryEnforced: true` flag in `chain.yaml` ensures the transition is clean.

---

## 4. Writing the chain.yaml

Create the file at `.codex/skills/<skill-name>/chain.yaml`. Use the chosen skill name as the directory name (e.g. `.codex/skills/polaris-run/chain.yaml`).

```yaml
version: "1.0"
cluster_id: "POL-7"
linear_parent: "POL-7"

children:
  - id: "POL-31"
    title: "[C6.1] Design native Polaris taskchain format"
    session_type: analyze
    blockedBy: []

  - id: "POL-32"
    title: "[C6.2] Implement polaris-run native taskchain skill"
    session_type: implement
    blockedBy: ["POL-31"]

loop:
  max_children_per_session: 3
  analyzeImplBoundaryEnforced: true

finalize:
  target: polaris
```

**Key fields:**

- `cluster_id` / `linear_parent` — the Linear parent issue ID. Set both to the same value.
- `children` — ordered list. Execution follows this order, subject to `blockedBy` constraints.
- `children[].session_type` — `analyze` or `implement`. All analyze children should come before implement children.
- `children[].blockedBy` — sibling child IDs that must reach Done before this child can start. Use `[]` for no dependencies.
- `loop.max_children_per_session` — how many children to complete before halting a session. Default `3`.
- `loop.analyzeImplBoundaryEnforced` — set `true` for mixed clusters; `false` only for purely-implement clusters where no boundary exists.
- `finalize.target` — the repo slug for `polaris finalize` to push to (`polaris` or `git-fit`).

For the full schema, see [`taskchain-format.md`](taskchain-format.md).

---

## 5. Session lifecycle

### Session start

**First session:**
1. Read `chain.yaml` to understand the cluster shape.
2. Initialize `.polaris/runs/current-state.json` from the chain (see `taskchain-format.md` → Mapping to LoopState).
3. For analyze sessions: write `echo "analyze" > .polaris/session-type`.
4. Run `polaris loop status` to confirm the first child.

**Resume session:**
1. Run `polaris loop resume` — verifies state SHA and loads the bootstrap packet from the prior session.
2. Run `polaris loop status` to confirm the next child.

### Mid-execution (child loop)

For each child in the session:

1. **Select** — take the next child from `open_children` whose `blockedBy` are all in `completed_children`.
2. **Execute** — implement the child per its Linear issue scope and done criteria.
3. **Commit** — `git commit -m "[POL-XX] Child title"`. One commit per child, always.
4. **Update Linear** — mark the child Done.
5. **Advance** — run `polaris loop continue`. This checkpoints state, checks the boundary, and emits the bootstrap packet.

### Session end

`polaris loop continue` determines what happens next:

- **Budget reached** (`children_completed >= max_children_per_session`): halt. Report the completed child, commit hash, next open child, and resume command.
- **Boundary enforced** (next child is implement-type in an analyze session): halt. Report the boundary event and the next implement child. Start a new `polaris-run` session.
- **Cluster complete** (no open children remain): proceed to finalize.
- **Blocked**: halt. See blocker protocol below.

---

## 6. Boundary enforcement

The analyze→implement boundary prevents an analyze session from accidentally writing production code.

**In practice:**
- `polaris-analyze` sessions execute only `session_type: analyze` children.
- When the next child in the list is `session_type: implement`, `polaris loop continue` fires a boundary enforcement event and halts — even if the context budget hasn't been reached.
- This is expected, not an error. The analyze session is done.
- Start a new session using the `polaris-run` skill to handle the implement children. Run `polaris loop resume` to re-enter from the checkpoint.

**What analyze sessions are allowed to produce:**
- Docs and specs (`docs/`, `docs/spec/`, `docs/planning/`)
- Linear issue updates

**What they must not touch:**
- `src/` or test files
- `polaris.config.json` or `.polaris/` state
- Any file that changes runnable behavior

The boundary is enforced by Polaris automatically — you do not need to check it manually.

---

## 7. Blocker protocol

If a child cannot proceed (missing dependency, upstream bug, unclear spec):

```
polaris loop abort "<reason>"
```

Then halt immediately. In your session report, include:
- What is blocked and why
- The explicit condition that would unblock it (e.g. "unblocked when POL-XX is Done")

**Do not:**
- Skip a blocked child and move to later children
- Mark a blocked child Done in Linear
- Leave the blocker undocumented

**Recovery:** once the unblock condition is met, start a new session with `polaris loop resume`. The aborted child will be the first child in the resumed session.

---

## 8. Delivery

When `open_children` is empty and all children are Done, run:

```
polaris finalize
```

`polaris finalize`:
1. Pushes the branch to the remote
2. Opens a pull request targeting `main`
3. Archives the run snapshot under `.taskchain_artifacts/`

Run `polaris finalize` **instead of** `polaris loop continue` on the last child — do not call both.

The PR title and body are generated from the cluster's Linear parent issue. Review the PR before merging; `polaris finalize` creates it, it does not auto-merge.

---

## 9. Common mistakes

### Scope creep during execution

A child says "implement X" and you also refactor Y and clean up Z while you're there. Each commit should trace directly to one child's done criteria. Unrelated improvements belong in a separate cluster child or a separate PR.

### Skipping `polaris loop continue`

Committing and updating Linear without running `polaris loop continue` leaves the state stale. The next session's `polaris loop resume` will fail the SHA check. Always run `polaris loop continue` after every child commit, in order.

### Missing `blockedBy` relations

Forgetting to declare a dependency means Polaris may attempt to execute a child before its upstream work is complete. Set `blockedBy` for every child that depends on the output of another child — even when the ordering "seems obvious."

### Analyze sessions writing code

Writing to `src/` in a `polaris-analyze` session bypasses the boundary and risks mixing design artifacts with implementation work. Analyze sessions produce docs and specs only. If you realize mid-session that you need to write code, halt, report the finding, and let the operator start a `polaris-run` session.

### Calling `polaris finalize` before all children are Done

`polaris finalize` is terminal — it archives the run. If you call it with open children remaining, the cluster is declared complete prematurely. Check `polaris loop status` before calling finalize.

### Batching multiple children into one commit

Each child must have its own commit. Batching makes it impossible to bisect regressions to a specific child and breaks the audit trail that `polaris map` relies on.
