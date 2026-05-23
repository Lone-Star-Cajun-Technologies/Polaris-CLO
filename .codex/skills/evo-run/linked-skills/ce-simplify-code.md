---
title: ce-simplify-code linkage
description: Support scoped cleanup or refactor children without widening evo-run implementation scope.
source: .codex/skills/ce-simplify-code/SKILL.md
version: "1.0"
---

# ce-simplify-code linkage

Source: `.codex/skills/ce-simplify-code/SKILL.md`

---

## Allowed steps

- 04-execute-child

---

## Purpose

Support scoped cleanup or refactor children without widening evo-run implementation scope.

---

## Allowed scope

- Simplify only the files or symbols named by the selected child
- Preserve existing behavior unless the child explicitly asks for a behavior change
- Keep changes small enough for child-level validation

---

## Forbidden scope

- Do not run broad cleanup
- Do not rename symbols with ad hoc find-and-replace
- Do not touch unrelated modules
- Do not invoke for feature work that is not cleanup or refactor scope

---

## Invocation note

Conditional. Invoke only when the selected child is a scoped cleanup or refactor task.
