---
title: ce-code-review linkage
description: Support scoped PR review or sanity-review children with correctness-focused review behavior.
source: .codex/skills/ce-code-review/SKILL.md
version: "1.0"
---

# ce-code-review linkage

Source: `.codex/skills/ce-code-review/SKILL.md`

---

## Allowed steps

- 04-execute-child

---

## Purpose

Support scoped PR review or sanity-review children with correctness-focused review behavior.

---

## Allowed scope

- Review the files and diffs named by the child
- Identify correctness, security, and test gaps within child scope
- Produce findings that can be resolved inside the current child

---

## Forbidden scope

- Do not review unrelated branches or PRs
- Do not rewrite implementation outside the child scope
- Do not perform final parent delivery review
- Do not invoke for ordinary implementation children

---

## Invocation note

Conditional. Invoke only when the selected child is explicitly a PR review or sanity-review task.
