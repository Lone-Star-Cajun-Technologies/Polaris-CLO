---
name: evo-closeout-step-05-compare-planned-vs-implemented
description: Check each acceptance criterion in the planning spec against implementation evidence.
---

# Step 05 — Compare planned vs implemented

## Purpose

Produce an evidence-based pass/fail record for every acceptance criterion in the planning spec.

## Scope declarations

```yaml
allowed_files:
  - selected planning spec from step 02
  - linked PR and commit evidence from step 03
  - graph check output from step 04
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-closeout/chain.md
  - docs/EVOnotes/planning-specs/**/*.md
allowed_skills:
  - none
expected_evidence:
  - planned criteria mapped to implemented evidence
  - gaps and partials listed
  - acceptance status assigned
stop_rules:
  - planned criterion lacks implementation evidence
  - implementation adds unplanned scope needing follow-up
  - comparison cannot be made from available artifacts
```
## Actions

For each acceptance criterion in the planning spec:

| Check | Pass condition |
|---|---|
| Feature or behavior described in spec | Corresponding code path exists and is confirmed by GitNexus or direct file inspection |
| Out-of-scope items in spec | No code changes found in those areas |
| Regression / testing evidence | A test command, manual validation note, or CI result is present |
| Doctrine conflicts | No unresolved conflict between the spec and `CLAUDE.md`, `docs/EVOnotes/doctrine/`, or active AGENTS.md |
| Silent scope expansion | All child issue changes stay within the parent scope; discoveries became follow-up issues, not silent additions |

Record pass/fail for each check with evidence. **Summarization rule**: one line per criterion — status + evidence reference only. Do not include raw git diffs, full test output, or verbose tool logs. First failing criterion only if multiple fail.

## Artifact update

Update `.taskchain_artifacts/evo-closeout/current-state.json`:
- `checks_performed: [<list of checks with pass/fail>]`
- `last_completed_step: 05-compare-planned-vs-implemented`
- `next_step: 06-closeout-decision`

## Next step

06-closeout-decision
