# polaris-run

Native Polaris taskchain skill for **implementation clusters**. Use this skill when all children are `session_type: implement` (or when an analyze→implement boundary has already been crossed in a prior session).

---

## Session start

1. If this is the **first session** for the cluster:
   - Read `chain.yaml` for the cluster to learn children, types, and dependencies.
   - Initialize `.polaris/runs/current-state.json` from `chain.yaml` (see taskchain-format spec).
   - Set `session_type: implement`.

2. If this is a **resume session**:
   - Run `polaris loop resume` — verifies state SHA, loads bootstrap packet, prints next child.

3. Run `polaris loop status` to confirm which child to execute next.

---

## Child loop

Repeat until budget exhausted, cluster complete, or blocked:

### 1. Select child

Take the next child from `open_children` whose `blockedBy` are all in `completed_children`. This is the active child.

### 2. Execute

Implement the child per its Linear issue scope and done criteria. Read the issue if needed.

### 3. Commit

```
git add <changed files>
git commit -m "[<CHILD-ID>] <child title>"
```

### 4. Update Linear

Mark the child issue **Done** in Linear.

### 5. Advance loop

```
polaris loop continue
```

This checkpoints state, runs `polaris map update --changed`, checks the analyze→impl boundary, and emits a bootstrap packet. The bootstrap packet is the handoff artifact for the next session.

---

## Session end

After `polaris loop continue` exits (or when budget is exhausted):

- **If more children remain**: stop. Report completed child, commit hash, next open child ID, and resume command: `polaris loop resume`.
- **If all children Done**: run `polaris finalize` instead of stopping.

---

## Finalize

When `open_children` is empty and all children are Done:

```
polaris finalize
```

This pushes the branch, opens a PR, and archives the run snapshot.

---

## Blocker protocol

If a child cannot proceed:

```
polaris loop abort "<reason>"
```

Halt immediately. Report the blocker and the unblock condition. Do not skip to later children.

---

## Constraints

- Commit after each child — never batch multiple children into one commit.
- Do not call `polaris loop continue` without a preceding commit.
- `polaris finalize` replaces `polaris loop continue` on the last child — do not call both.
