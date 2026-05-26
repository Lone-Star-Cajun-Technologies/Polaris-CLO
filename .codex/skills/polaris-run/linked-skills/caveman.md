---
title: caveman linkage
description: Keep polaris-run orientation and status reporting terse while preserving technical accuracy.
source: .codex/skills/caveman/SKILL.md
version: "1.0"
---

# caveman linkage

Source: `.codex/skills/caveman/SKILL.md`

---

## Allowed steps

- 01-orient-cluster

---

## Purpose

Keep polaris-run orientation and status reporting terse while preserving technical accuracy.

---

## Allowed scope

- Confirm parent issue, branch, children, blockers, and doctrine pointers
- Apply full compression (caveman-full) for all user-facing checkpoints
- Summarize orientation evidence without broad traversal

---

## Forbidden scope

- Do not replace Linear state checks
- Do not compress generated code, safety warnings, blocker descriptions, or acceptance-criteria gaps
- Do not perform broad repo analysis
- Do not invoke outside step 01

---

## Invocation note

Optional at session start. If Caveman is available, activate in full mode (caveman-full) during step 01 for terse orientation output.
If Caveman is not installed, Polaris uses native compact behavior as the required baseline; note the provider status and proceed.
See `docs/spec/polaris-compact-contracts.md` §8 for the polaris-native compact baseline and provider compatibility rules.
