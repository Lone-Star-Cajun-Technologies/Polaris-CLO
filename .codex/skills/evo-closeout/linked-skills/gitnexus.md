---
title: gitnexus linkage
description: Verify closeout implementation evidence against relevant GitNexus code paths.
source: .codex/skills/gitnexus/SKILL.md
version: "1.0"
---

# gitnexus linkage

Source: `.codex/skills/gitnexus/SKILL.md`

---

## Allowed steps

- 04-gitnexus-graph-check

---

## Purpose

Verify closeout implementation evidence against relevant GitNexus code paths.

---

## Allowed scope

- Query relevant code paths touched by the implementation
- Inspect specific symbols and flows tied to linked PRs, commits, or child issue scopes
- Check whether GitNexus has been re-indexed since relevant implementation commits
- Use targeted follow-up only when step 04 findings require it

---

## Forbidden scope

- Do not perform broad repo dumps
- Do not invoke in steps 01-03
- Do not invoke in steps 05-07 except as targeted follow-up to step 04 findings
- Do not replace closeout decision routing
- Do not weaken the mandatory GitNexus requirement

---

## Staleness rule

If implementation touched relevant code paths and GitNexus has not been re-indexed since those commits:
- Mark closeout as `closeout_blocked` or `closeout_partial`.
- Include a stale-index warning in the report.
- Run `npx gitnexus analyze` and re-check before unblocking.

---

## Invocation note

Mandatory in every closeout run during 04-gitnexus-graph-check.
