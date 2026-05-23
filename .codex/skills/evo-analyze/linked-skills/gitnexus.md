---
title: gitnexus linkage
description: Map issue-relevant code surfaces and risk with targeted GitNexus inspection.
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

Map issue-relevant code surfaces and risk with targeted GitNexus inspection.

---

## Allowed scope

- Check GitNexus freshness during orientation
- Query only symbols, files, or concepts relevant to the issue scope
- Map affected code in step 02
- Report stale-index warnings and combine with direct file inspection

---

## Forbidden scope

- Do not perform broad repo dumps
- Do not invoke in steps 03-assess-issue through 06-final-report
- Do not replace doctrine review or Linear issue analysis
- Do not continue past HIGH or CRITICAL risk without surfacing it

---

## Invocation note

Conditional for targeted lookup in steps 01 and 02 only. If the index is stale, report it and verify with direct repository inspection.
