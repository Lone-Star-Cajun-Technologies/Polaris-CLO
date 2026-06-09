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

This linked-skill governs use of the configured repo-analysis provider (e.g., GitNexus). If no provider is available, the fallback path (polaris map query + ripgrep + direct file inspection) is authoritative. See `docs/Polaris/spec/provider-capabilities.md` for the full provider model.

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

At step 01, check `polaris.config.json` for `providers.repoAnalysis.preferred`.
If a provider is configured and available in the session environment: use it.
If unavailable or not configured: note `repo_analysis_status: not-configured` in artifact and proceed with fallback.

---

## Invocation note

Conditional. Invoke only when a child requires code intelligence, symbol impact, or change-scope verification. When the provider is unavailable, the fallback path runs instead — execution continues.
