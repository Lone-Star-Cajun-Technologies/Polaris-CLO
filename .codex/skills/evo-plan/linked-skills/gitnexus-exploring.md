# gitnexus-exploring linkage

Source: `.claude/skills/gitnexus-exploring/SKILL.md`

---

## Allowed phases

- 03 — canonical-note-traversal
- 04 — reuse-analysis
- 05 — gap-analysis

---

## Purpose

Targeted symbol and runtime wiring inspection to understand how existing systems are wired in the codebase. Query only concepts relevant to the target domain.

---

## Allowed scope

- Query specific symbols, functions, or classes relevant to the current phase
- Inspect execution flows for the target domain
- Verify whether a system already exists or is wired
- Assess reuse candidates in Phase 04
- Confirm wiring gaps in Phase 05

---

## Forbidden scope

- Do not perform broad repo dumps or full codebase scans
- Do not replace doctrine traversal — gitnexus supplements doctrine, it does not substitute for it
- Do not dump large code contexts into the planning session
- Do not perform implementation work
- Do not invoke outside allowed phases

---

## Staleness rule

If gitnexus reports a stale index, report the staleness and combine targeted gitnexus results with direct repository inspection. Do not assume the index is current.

---

## Invocation note

Before invoking, confirm the current phase is in the allowed list above. Use targeted queries only. Summarize findings — do not carry raw symbol dumps between phases.
