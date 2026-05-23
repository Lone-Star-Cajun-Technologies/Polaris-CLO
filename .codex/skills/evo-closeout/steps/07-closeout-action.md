---
name: evo-closeout-step-07-closeout-action
description: Execute the file action (or hold) that matches the closeout decision from step 06.
---

# Step 07 — Closeout action

## Purpose

Execute the correct outcome action based on the decision from step 06. Terminal step.

---

## Branch A — closeout_passed: promote the planning spec

1. Determine the target implemented folder from `domain_lifecycle`. Create the folder if it does not exist:
   - `ai` → `docs/EVOnotes/implemented/ai/`
   - `connect` → `docs/EVOnotes/implemented/connect/`
   - `governance` → `docs/EVOnotes/implemented/governance/`
   - `learn` → `docs/EVOnotes/implemented/learn/`
   - `mind` → `docs/EVOnotes/implemented/mind/`
   - `runtime` → `docs/EVOnotes/implemented/runtime/`
   - `training` → `docs/EVOnotes/implemented/training/`
   - Other or missing → `docs/EVOnotes/implemented/`

2. Read the planning spec file.

3. Merge the following closeout fields into the existing frontmatter block (update or add keys within the single `---` block — do not create a second frontmatter block):
   - `lifecycle_status: implemented`
   - `implementation_status: implemented`
   - `closeout_date: YYYY-MM-DD`
   - `closeout_status: closeout_passed`
   - `linear_parent: EVOC-XXX`
   - `linear_children: [EVOC-XXX.1, EVOC-XXX.2, ...]`
   - `linked_prs: [PR#NNN, ...]`
   - `linked_commits: [abc1234, ...]`
   - `implementation_summary: |` (one paragraph describing what was actually built)
   - `validation_evidence: |` (test command, CI result, or manual check)
   - `known_followups: [...]` (descriptions of follow-up issues created)
   - `gitnexus_index_status: fresh | stale-at-closeout`

4. Move the file from `docs/EVOnotes/planning-specs/<filename>` to the target implemented folder. Do not copy — move. Do not leave a stub in planning-specs.

5. If a matching raw planning doc exists in `docs/raw/`, move it to `docs/raw/archived/`.

6. Report the promoted file path and updated frontmatter.

---

## Branch B — closeout_blocked: produce blocker report

Do not move any files.

Produce the following:

**Missing implementation list**
For each unmet acceptance criterion, describe what is missing and which spec section it maps to.

**Unresolved doctrine conflicts**
List any conflict between the implementation or spec and active doctrine files, with the conflicting file reference.

**Missing tests or validation**
List acceptance criteria with no documented validation evidence.

**GitNexus status**
State whether the index is current. If stale:
```bash
npx gitnexus analyze
```

**Follow-up Linear-ready issue list**
For each gap requiring follow-up:
```text
Title: [short action title]
Parent: EVOC-XXX
Description: [what needs to happen and why]
Acceptance criteria: [one verifiable condition]
```

**Recommended next action**
State clearly what must happen before closeout can be re-run and passed.

---

## Branch C — closeout_partial: conditional promotion

Default: do not move any files.

If and only if the user explicitly requests partial promotion:

1. Follow the same file-move and frontmatter-merge steps as Branch A.
2. Set `closeout_status: closeout_partial` in the frontmatter (not `closeout_passed`).
3. Add an `unmet_criteria` field listing each unsatisfied acceptance criterion.
4. Include the follow-up issue list and residual risks in `known_followups`.

Do not promote silently. The user must acknowledge the gaps before promotion proceeds.

---

## Branch D — needs_human_decision: hold and report

Do not move any files.

Describe the ambiguous findings and state what specific human judgment is required before closeout can be re-run.

---

## Final report structure (all branches)

Return a structured summary:

1. **Parent issue** — ID, title, final state
2. **Child issues** — ID, title, state, linked PR/commit for each
3. **Planning spec** — path, current lifecycle_status
4. **GitNexus status** — fresh or stale, refreshed or not
5. **Checks performed** — pass/fail table with evidence for each acceptance criterion
6. **Closeout decision** — `closeout_passed` / `closeout_blocked` / `closeout_partial` / `needs_human_decision`
7. **Action taken** — spec promoted to path (if passed) or blocker report (if blocked/partial)
8. **Follow-up issues** — list of Linear-ready issue descriptions if applicable
9. **Residual risks** — anything uncertain or requiring monitoring after closeout

## Scope declarations

```yaml
allowed_files:
  - selected planning spec path
  - docs/EVOnotes/implemented/**
  - docs/EVOnotes/needs-review/**
  - closeout artifacts from steps 01-06
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-closeout/chain.md
  - docs/EVOnotes/planning-specs/**/*.md
allowed_skills:
  - none
expected_evidence:
  - approved promotion or blocker report written
  - frontmatter/index/backlinks updated when applicable
  - Linear/GitHub evidence comment prepared
stop_rules:
  - promotion would move stale or conflicting doctrine
  - destination instructions forbid update
  - required evidence artifacts are incomplete
```
## Artifact update

Update `.taskchain_artifacts/evo-closeout/current-state.json`:
- `status: complete`
- `spec_promoted_to: <path or "none">`
- `last_completed_step: 07-closeout-action`
- `next_step: none`
- `completed_at: <timestamp>`

## Session end

This is the terminal step.
