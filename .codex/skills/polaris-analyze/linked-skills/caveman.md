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

Detection is not activation. Polaris-native compact is the default baseline regardless of whether Caveman is present.

Only activate Caveman if it is explicitly enabled for the current run via config or invocation flag. Do not auto-activate because Caveman is installed or this file is present.

If Caveman is explicitly enabled: activate in lite mode for terse session checkpoints.
If Caveman is not explicitly enabled: confirm Polaris-native compact baseline is in effect (per `docs/spec/polaris-compact-contracts.md` §8) and proceed.
See `docs/spec/polaris-compact-contracts.md` §8 for the polaris-native compact baseline and provider compatibility rules.
