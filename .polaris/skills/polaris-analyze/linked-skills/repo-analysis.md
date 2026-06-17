---
title: repo-analysis provider linkage
description: Provide targeted code intelligence when a repo-analysis provider is configured and available in the session environment.
version: "1.0"
---

# repo-analysis provider linkage

---

## Allowed steps

- 01-fetch-and-orient
- 02-map-affected-code

---

## Purpose

Provide targeted code intelligence when polaris-analyze needs to understand the affected code surface.

This linked-skill governs repository code-intelligence for polaris-analyze. The primary path is Polaris-native: `polaris graph query`, `polaris graph impact`, and `polaris map query`. If the Polaris graph is unavailable or stale, fall back to `rg` (ripgrep) plus direct file inspection. See `docs/Polaris/spec/provider-capabilities.md` for the full provider model.

---

## Allowed scope

- Check configured provider availability at session start
- Query specific files, symbols, or concepts relevant to the issue scope
- Run impact analysis on symbols mentioned in the issue
- Check provider index freshness and trigger refresh if stale
- Report execution flows relevant to the issue

---

## Forbidden scope

- Do not perform broad graph dumps or full-repo reports
- Do not replace direct repository inspection
- Do not invoke outside allowed steps
- Do not assume a specific provider product is present — check availability first

---

## Provider detection

At step 01, attempt `polaris graph query` to orient to the code surface. If the graph index is current, use it as primary.
If the graph is unavailable or returns stale results: note `repo_analysis_status: graph-unavailable` in artifact and proceed with `rg` + direct inspection fallback.

---

## Invocation note

Conditional. Invoke when the issue references specific files, symbols, or flows that benefit from graph context. When the provider is unavailable, the fallback path runs instead — the session continues either way.
