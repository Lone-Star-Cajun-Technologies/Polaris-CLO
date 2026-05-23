---
title: ce-debug linkage
description: Guide bounded bug investigation when the selected child is explicitly a debugging task.
source: .codex/skills/ce-debug/SKILL.md
version: "1.0"
---

# ce-debug linkage

Source: `.codex/skills/ce-debug/SKILL.md`

---

## Allowed steps

- 04-execute-child

---

## Purpose

Guide bounded bug investigation when the selected child is explicitly a debugging task.

---

## Allowed scope

- Reproduce or reason through the scoped bug
- Inspect only files relevant to the selected child
- Identify the smallest fix needed for the bug

---

## Forbidden scope

- Do not perform broad architecture review
- Do not refactor unrelated code
- Do not diagnose later children
- Do not invoke for non-bug children

---

## Invocation note

Conditional. Invoke only when the current child is a bug investigation or failure triage task.
