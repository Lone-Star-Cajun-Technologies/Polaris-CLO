# polaris-analyze

Native Polaris taskchain skill for **analysis clusters**. Use this skill when children are `session_type: analyze` — producing specs, designs, and planning artifacts. When all analyze children are done, `polaris loop continue` enforces the analyze→implement boundary automatically; a fresh `polaris-run` session handles any subsequent implementation children.

---

## Session start

1. Write `.polaris/session-type`:
   ```
   echo "analyze" > .polaris/session-type
   ```
   This signals boundary enforcement to `polaris loop continue`.

2. If this is the **first session**:
   - Read `chain.yaml` for the cluster to learn children and dependencies.
   - Initialize `.polaris/runs/current-state.json` with `session_type: analyze`.

3. If this is a **resume session**:
   - Run `polaris loop resume` to verify state and load bootstrap packet.

4. Run `polaris loop status` to confirm the next analyze child.

---

## Child loop

Repeat for each analyze child:

### 1. Select child

Take the next child from `open_children` whose `blockedBy` are all in `completed_children`. Must be `session_type: analyze`.

### 2. Execute

Produce the analysis output per the child's Linear issue scope. Allowed outputs:
- Docs, specs, and planning files (`docs/`, `docs/spec/`, `docs/planning/`)
- Linear issue updates (findings, notes, links)

**Not allowed in analyze sessions:**
- Source code changes (`src/`, test files)
- Config changes (`polaris.config.json`, `.polaris/`)
- Any commit that modifies runnable code

### 3. Commit

```
git add <docs and spec files only>
git commit -m "[<CHILD-ID>] <child title>"
```

### 4. Update Linear

Mark the child issue **Done** in Linear.

### 5. Advance loop

```
polaris loop continue
```

If the next child is `session_type: implement`, `polaris loop continue` fires the boundary enforcement event and halts. This is the expected end of the analyze session — not an error.

---

## Session end

After `polaris loop continue` exits:

- **Boundary enforced** (next child is implement-type): stop. Report the boundary event, the last completed analyze child, and the next implement child. The operator must start a new `polaris-run` session.
- **More analyze children remain**: stop on context budget. Report next open child and resume command: `polaris loop resume`.
- **All children Done and all are analyze-type**: run `polaris finalize`.

---

## Blocker protocol

```
polaris loop abort "<reason>"
```

Halt immediately. Report the blocker and the unblock condition.

---

## Constraints

- Never modify `src/` or test files in an analyze session.
- Never call `polaris finalize` unless all cluster children are Done (including any implement-type children that ran in a separate `polaris-run` session).
- The analyze→implement boundary is enforced by Polaris, not by this skill. Do not manually check or replicate it.
