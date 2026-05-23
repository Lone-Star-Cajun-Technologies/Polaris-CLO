---
name: gitnexus
description: "Targeted GitNexus code intelligence for git-fit: query code context, inspect symbol impact, and detect changed execution flows without broad repo dumps."
---

# GitNexus

Use this skill when a workflow needs targeted code intelligence from GitNexus
before editing, validating, or committing code in this repository.

## Source of truth

Use the GitNexus MCP tools exposed in Codex as the runnable interface:

- `mcp__gitnexus__context`
- `mcp__gitnexus__impact`
- `mcp__gitnexus__detect_changes`
- `mcp__gitnexus__api_impact`
- `mcp__gitnexus__route_map`
- `mcp__gitnexus__shape_check`

Claude reference material remains under `.claude/skills/gitnexus/`, but this
file is the Codex skill wrapper and canonical repo-local entrypoint.

## Rules

- Use targeted queries for specific symbols, routes, files, or concepts.
- Do not run broad graph dumps when direct file inspection is enough.
- Before modifying a significant function, class, method, or route handler, run
  the matching impact check and report high or critical risk before editing.
- Before committing, run `detect_changes` on the relevant diff scope.
- If GitNexus reports a stale index, report the staleness and combine targeted
  GitNexus output with direct repository inspection.

## Stop conditions

Stop and report if the tool output indicates high or critical blast radius that
would expand beyond the current issue, or if the index is too stale for the
requested risk assessment and direct inspection cannot close the gap.
