---
name: docs-promote
status: retired
retired_by: polaris-catalog
description: RETIRED — use polaris-catalog instead. docs-promote has been replaced by polaris-catalog, which combines cognition reconciliation with confidence-gated document classification.
role: librarian
role_file: .polaris/roles/librarian.md
---

## RETIRED

This skill has been retired. Use `polaris-catalog` instead.

`polaris-catalog` provides the same document classification and placement behavior with
confidence-gated automation (high confidence = auto-place, low confidence = ask or hold),
plus POLARIS.md and SUMMARY.md reconciliation in the same invocation.

Do not invoke this skill. If you received this message after attempting `docs-promote`,
stop and use `polaris-catalog <POL-###>` instead.

---

## Polaris Skill Bootloader

**Before proceeding, you must obtain a skill packet from the Polaris runtime.**

Run the following command:

```
polaris skill packet promote
```

- Do not begin work until a packet is returned.
- Treat the packet as your authoritative instruction source.
- The packet defines your active role, authority boundaries, prohibited actions, deliverables, and stop conditions.
- If no packet is produced, stop and report: **Polaris could not authorize this run.**

---

# docs-promote

Use this skill when documents have been ingested and need to be reviewed for promotion to an active authority tier, or when active docs need to be deprecated in response to code changes.

## When to use

- "Review the candidates and promote anything ready"
- "Promote the spec for the dispatch contract"
- "Deprecate the old architecture doc — it's been superseded"
- "Check what doctrine candidates are ready to promote"
- "A raw spec needs to go active before we start implementation"

## How to execute

1. Read `chain.md` — step order, review rules, CLI commands, conflict handling.
2. Read `.taskchain_artifacts/docs-promote/current-state.json` — resumable state.
3. Execute steps in the order `chain.md` defines. Do not skip steps.
4. After every completed step, update `current-state.json` before advancing.

## Hard rules — what docs-promote may do

- Read `smartdocs/raw/` and `smartdocs/doctrine/candidate/` to identify promotion candidates
- Read linked source files (from `linkedMapArea` in provenance sidecar) to verify relevance and staleness
- Read `smartdocs/doctrine/active/` and `smartdocs/specs/active/` to check for conflicts
- Call `polaris doctrine spec-promote <path>` to surface the conflict report (without `--approve`)
- Call `polaris doctrine spec-promote <path> --approve` **only after** surfacing the report and receiving explicit user confirmation
- Call `polaris doctrine promote <path>` for doctrine candidates that pass governance checks
- Call `polaris doctrine deprecate <path>` for active docs that are superseded or stale
- Emit telemetry events

## Hard rules — what docs-promote must NOT do

- Auto-promote without surfacing the conflict report first
- Call `--approve` without explicit user confirmation in the session
- Mutate source files (`src/`, tests, config)
- Call `polaris loop continue` or `polaris finalize`
- Promote to `architecture/` or `decisions/` — those require explicit ADR process
- Suppress or ignore detected conflicts

**Docs-promote reviews and surfaces. It does not promote silently or bypass the approval gate.**
