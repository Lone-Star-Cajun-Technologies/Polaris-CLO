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

Detection is not activation. Polaris-native compact is the default baseline regardless of whether Caveman is present.

Only activate Caveman if it is explicitly enabled for the current run via config or invocation flag. Do not auto-activate because Caveman is installed or this file is present.

If Caveman is explicitly enabled: activate in full mode (caveman-full) during step 01 for terse orientation output.
If Caveman is not explicitly enabled: confirm Polaris-native compact baseline is in effect (per `docs/spec/polaris-compact-contracts.md` §8) and proceed.
See `docs/spec/polaris-compact-contracts.md` §8 for the polaris-native compact baseline and provider compatibility rules.
