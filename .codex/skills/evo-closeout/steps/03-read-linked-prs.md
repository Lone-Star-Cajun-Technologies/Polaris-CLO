---
name: evo-closeout-step-03-read-linked-prs
description: Read linked PRs, commits, and implementation notes to collect evidence for verification.
---

# Step 03 — Read linked PRs and commits

## Purpose

Collect the implementation evidence needed for the planned-vs-implemented comparison in step 05.

## Scope declarations

```yaml
allowed_files:
  - GitHub PRs linked from Linear issue
  - commit metadata for linked PR branches
  - changed-file lists from linked PRs
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-closeout/chain.md
  - docs/EVOnotes/planning-specs/**/*.md
allowed_skills:
  - none
expected_evidence:
  - linked PRs and commits read
  - delivery status captured
  - changed paths summarized
stop_rules:
  - linked PR missing or inaccessible
  - PR is not merged/ready for closeout
  - commit history cannot be tied to target issue
```
## Actions

For each linked PR or commit referenced in the Linear issues:

1. Read the PR title, body, and linked child issues.
2. Note files changed.
3. Note any reviewer comments, CodeRabbit findings, or manual validation notes.
4. Collect any inline acceptance criteria evidence from child issue comments.

Do not read unrelated files. Limit inspection to files mentioned in PRs, commits, or child issue scopes.

## Artifact update

Update `.taskchain_artifacts/evo-closeout/current-state.json`:
- `last_completed_step: 03-read-linked-prs`
- `next_step: 04-gitnexus-graph-check`
- `notes: <append list of PRs/commits reviewed>`

## Next step

04-gitnexus-graph-check
