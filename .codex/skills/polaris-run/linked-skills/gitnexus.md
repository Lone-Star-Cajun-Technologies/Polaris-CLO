---
title: gitnexus linkage
description: Provide targeted code intelligence and impact checks when polaris-run needs repository graph context.
source: .codex/skills/gitnexus/SKILL.md
version: "1.0"
---

# gitnexus linkage

Source: `.codex/skills/gitnexus/SKILL.md`

---

## Allowed steps

- 01-orient-cluster
- 02-prepare-branch
- 03-select-child
- 04-execute-child

---

## Purpose

Provide targeted code intelligence and impact checks when polaris-run needs repository graph context.

---

## Allowed scope

- Query specific files, symbols, or concepts relevant to the current child
- Run impact analysis before modifying significant symbols
- Run targeted context checks to locate implementation surfaces
- Report stale-index warnings and pair them with direct inspection

---

## Forbidden scope

- Do not perform broad graph dumps or full-repo reports
- Do not replace direct repository inspection
- Do not expand implementation beyond the selected child
- Do not invoke outside allowed steps

---

## Invocation note

Conditional. Invoke only when a child requires code intelligence, symbol impact, or change-scope verification.
