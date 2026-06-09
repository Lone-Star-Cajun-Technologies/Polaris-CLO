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

This linked-skill governs use of the configured repo-analysis provider (e.g., GitNexus). If no provider is available, the fallback path (polaris map query + ripgrep + direct file inspection) is authoritative. See `docs/Polaris/spec/provider-capabilities.md` for the full provider model.

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

At step 01, check `polaris.config.json` for `providers.repoAnalysis.preferred`.
If a provider is configured and available in the session environment: use it.
If unavailable or not configured: note `repo_analysis_status: not-configured` in artifact and proceed with fallback.

---

## Invocation note

Conditional. Invoke when the issue references specific files, symbols, or flows that benefit from graph context. When the provider is unavailable, the fallback path runs instead — the session continues either way.
