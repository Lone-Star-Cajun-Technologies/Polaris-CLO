---
title: caveman linkage
description: Keep polaris-analyze user-facing status updates terse while preserving planning and blocker detail.
source: .codex/skills/caveman/SKILL.md
version: "1.0"
---

# caveman linkage

Source: `.codex/skills/caveman/SKILL.md`

---

## Allowed steps

- Session start before 01-fetch-and-orient

---

## Purpose

Keep polaris-analyze user-facing status updates terse while preserving planning and blocker detail.

---

## Allowed scope

- Apply lite reporting for session checkpoints
- Keep routine orientation and status updates brief
- Preserve full content for generated planning artifacts and final reports

---

## Forbidden scope

- Do not compress child issue bodies or cluster plans
- Do not compress blocker reports or unblock conditions
- Do not compress doctrine conflict findings
- Do not compress HIGH or CRITICAL GitNexus risk findings
- Do not replace required artifact updates

---

## Invocation note

Optional at session start. If Caveman is available, activate in lite mode to govern user-facing responses for the duration of the run.
If Caveman is not installed, Polaris uses native compact behavior as the required baseline; note the provider status and proceed.
See `docs/spec/polaris-compact-contracts.md` §8 for the polaris-native compact baseline and provider compatibility rules.
