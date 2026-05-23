---
title: caveman-compress linkage
description: Compress handoff state before stopping, handoff, or context-risk boundaries.
source: .codex/skills/caveman-compress/SKILL.md
version: "1.0"
---

# caveman-compress linkage

Source: `.codex/skills/caveman-compress/SKILL.md`

---

## Allowed steps

- 07-decide-continuation

---

## Purpose

Compress handoff state before stopping, handoff, or context-risk boundaries.

---

## Allowed scope

- Summarize completed child, commit, validation, blockers, and next open child
- Preserve exact blocker descriptions and resume commands
- Keep the current-run ledger and Linear state as source of truth

---

## Forbidden scope

- Do not compress generated code or doctrine text
- Do not omit blocker details
- Do not replace the required current-run update
- Do not invoke during normal child implementation

---

## Invocation note

Conditional. Invoke before stopping, handoff, or when context risk is high.
