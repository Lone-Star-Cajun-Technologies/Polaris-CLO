---
title: repo-analysis provider linkage
description: Provide targeted code intelligence and impact checks when a repo-analysis provider is configured and available in the session environment.
version: "1.0"
---

# repo-analysis provider linkage

---

## Allowed steps

- 01-orient-cluster
- 02-prepare-branch
- 03-select-child
- 04-execute-child

---

## Purpose

Provide targeted code intelligence and impact checks when polaris-run needs repository graph context.

This linked-skill governs repository code-intelligence for polaris-run. The primary path is Polaris-native: `polaris graph query`, `polaris graph impact`, and `polaris map query`. If the Polaris graph is unavailable or stale, fall back to `rg` (ripgrep) plus direct file inspection. See `docs/Polaris/spec/provider-capabilities.md` for the full provider model.

---

## Allowed scope

- Check configured provider availability at session start
- Query specific files, symbols, or concepts relevant to the current child
- Run impact analysis before modifying significant symbols
- Run targeted context checks to locate implementation surfaces
- Report stale-index warnings and pair them with direct inspection

---

## Forbidden scope

- Do not perform broad graph dumps or full-repo reports
- Do not replace direct repository inspection
- Do not expand implementation beyond the selected child
- Do not invoke outside allowed steps
- Do not assume a specific provider product is present — check availability first

---

## Provider detection

At step 01, attempt `polaris graph query` to orient to the code surface. If the graph index is current, use it as primary.
If the graph is unavailable or returns stale results: note `repo_analysis_status: graph-unavailable` in artifact and proceed with `rg` + direct inspection fallback.

---

## Invocation note

Conditional. Invoke only when a child requires code intelligence, symbol impact, or change-scope verification. When the provider is unavailable, the fallback path runs instead — execution continues.
