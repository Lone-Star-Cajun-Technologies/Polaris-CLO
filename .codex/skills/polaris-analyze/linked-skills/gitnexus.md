---
title: gitnexus linkage
description: Provide targeted code intelligence for polaris-analyze during repo inspection and affected-code mapping.
source: .codex/skills/gitnexus/SKILL.md
version: "1.0"
---

# gitnexus linkage

Source: `.codex/skills/gitnexus/SKILL.md`

---

## Allowed steps

- 01-fetch-and-orient
- 02-map-affected-code

---

## Purpose

Provide targeted code intelligence when polaris-analyze needs to understand the affected code surface.

---

## Allowed scope

- Query specific files, symbols, or concepts relevant to the issue scope
- Run impact analysis on symbols mentioned in the issue
- Check GitNexus freshness and trigger refresh if stale
- Report execution flows relevant to the issue

---

## Forbidden scope

- Do not perform broad graph dumps or full-repo reports
- Do not replace direct repository inspection
- Do not invoke outside allowed steps

---

## Invocation note

Conditional. Invoke when the issue references specific files, symbols, or flows that benefit from graph context.
