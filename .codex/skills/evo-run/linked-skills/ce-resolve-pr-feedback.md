---
title: ce-resolve-pr-feedback linkage
description: Handle scoped CodeRabbit, reviewer, or PR feedback resolution when that is the selected child.
source: .codex/skills/ce-resolve-pr-feedback/SKILL.md
version: "1.0"
---

# ce-resolve-pr-feedback linkage

Source: `.codex/skills/ce-resolve-pr-feedback/SKILL.md`

---

## Allowed steps

- 04-execute-child

---

## Purpose

Handle scoped CodeRabbit, reviewer, or PR feedback resolution when that is the selected child.

---

## Allowed scope

- Inspect the feedback referenced by the child
- Apply only feedback accepted within the child scope
- Record unresolved or out-of-scope feedback as a blocker or follow-up

---

## Forbidden scope

- Do not resolve feedback from unrelated PRs
- Do not silently expand into opportunistic cleanup
- Do not push or create PRs from step 04
- Do not invoke without explicit reviewer-feedback scope

---

## Invocation note

Conditional. Invoke only for CodeRabbit, reviewer feedback, or PR feedback children.
