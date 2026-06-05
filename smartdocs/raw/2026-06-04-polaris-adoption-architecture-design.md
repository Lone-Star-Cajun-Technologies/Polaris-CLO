---
status: raw
created: 2026-06-04
title: Polaris Adoption Architecture Design
tags: [adoption, architecture, cognition, token-burn, doctrine]
---

# Polaris Adoption Architecture Design

## Overview

This document defines the canonical architecture for adopting an existing repository into the
Polaris runtime, optimizing for minimum recurring token burn while ensuring the repository is
immediately runnable. It covers the Temporary Worker Doctrine, agent document architecture,
route cognition scaffold, SmartDocs migration, map-query enforcement, tracker agnosticism, and
default role assignment.

**Primary question this spec answers:**

> How do we make a newly adopted repository immediately runnable while allowing cognition quality
> to improve incrementally over time without requiring agents to load large repository artifacts?

---

## Doctrine

### D1 — Temporary Worker Doctrine

> Every model instance is a temporary occupant of a durable role. Roles persist; model instances
> are disposable.

Examples of durable roles: Analyst, Foreman, Worker, Librarian, Medic (reserved).

A worker should arrive at a task knowing only:
- what job it is doing
- what files it may touch
- what route governs the work
- what validation proves completion

A worker should not need broad repository context. If a worker requires broad context, the
cognition structure has failed — not the worker.

### D2 — Repository Memory Doctrine

> Polaris stores institutional memory in repository artifacts rather than model memory.
>
> Knowledge should be discoverable through navigation, route cognition, SmartDocs, summaries,
> commits, telemetry, and runtime artifacts.
>
> Workers should not rely on persistent model memory to perform assigned work.

This doctrine is the foundation behind:
- Temporary Worker Doctrine
- Route-local cognition
- Librarian reconciliation
- Query-over-load
- SmartDocs
- Tracker agnosticism

### D3 — Map Doctrine

> The map is runtime infrastructure. Query results are model context.
>
> Agents may query the map. Agents may not consume map artifacts.

Use the canonical query command:
```
polaris map query <path>
```

Never read these files directly:
- `.polaris/map/file-routes.json`
- `.polaris/map/index.json`
- `.polaris/map/needs-review.json`

These paths may appear only in prohibition lists. Any model-facing doc or skill chain that
instructs loading these files directly is a defect.

### D4 — Agent File Doctrine

> Agent files are pointers. `POLARIS_RULES.md` is the governance source.

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CODEX.md`, and equivalent provider bootstrap files
contain no routing logic, no governance, no command tables, no doctrine, and no repo overview.
They are pointers only.

### D5 — Route Cognition Doctrine

> Route-local cognition is adaptive. Adoption seeds the obvious routes; future work may create
> deeper routes when a folder becomes an independent work surface.

A route is a work-owning area of the repository — a place where Polaris may assign work and
where local cognition reduces parent-context bloat. Routes are not every physical directory.

### D6 — SmartDocs Trust Doctrine

> All imported docs begin as raw. Nothing is auto-promoted. Nothing is auto-trusted.

### D7 — SmartDocs Ignore Doctrine

> Bootstrap artifacts and route cognition files are SmartDocs-ignored. SmartDocs-ignore means
> excluded from ingestion, promotion, and doctrine generation. It does not mean hidden from
> workers, Foreman, Librarian, or routing.

Three distinct artifact layers:

| Layer | Files | Readable by agents? | SmartDocs-ingested? |
|---|---|---|---|
| Bootstrap | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CODEX.md`, `POLARIS_RULES.md` | Yes | No |
| Route cognition | `POLARIS.md`, `SUMMARY.md` | Yes | No |
| Doctrine | `smartdocs/**` | Yes | Yes |

### D8 — Tracker Agnosticism Doctrine

> Work identifiers are opaque to the model. Polaris is tracker-agnostic.

Work may originate from Linear, GitHub, a SmartDocs spec, a local work contract, a manual
prompt, or a future provider. Agent-facing instructions use `<CLUSTER-ID>`, not `POL-###`.
The runtime resolves identifiers. The model does not.

### D9 — Adoption Principle

> Adopt runnable first. Improve cognition incrementally.

A repository is usable immediately after Stage 1. No adoption stage blocks execution.

### D10 — Role Staffing Doctrine

> Polaris initializes durable roles first, then assigns providers/models as configurable
> occupants of those roles. Roles persist. Model instances are disposable.

### D11 — Librarian Reconciliation Doctrine

> Every completed run requires Librarian reconciliation before final delivery.
>
> Implementation complete is not run complete.

Run complete means all of the following are true:
1. Implementation completed
2. Sealed worker/result packets exist
3. Librarian reconciliation completed
4. Cognition and doc updates are committed or explicitly no-op
5. Finalize/PR delivery may proceed

The Librarian pass operates from the run/result packet, commits, changed files, linked docs,
and route cognition. It does not rerun implementation.

**Role authority:**

> A provider may occupy multiple roles, but role authority does not merge.
>
> Shared provider is allowed. Shared authority is not.

The Librarian must run under Librarian role authority. The Foreman may dispatch a Librarian
subagent if no dedicated Librarian provider is configured, but the Foreman must not personally
perform Librarian work. The subagent runs under Librarian role authority and writes a sealed
Librarian result.

**Run completion flow:**
```
Implementation run
  → result packet
  → Librarian subagent/role reconciliation
  → POLARIS.md / SUMMARY.md / SmartDocs updates
  → sealed Librarian result
  → finalize gate passes
  → PR creation
```

The Librarian may execute either as part of finalize or as a separate closeout skill before
finalize. Final delivery is gated on Librarian completion in either case.

---

## Agent Document Architecture

### Pointer Files

All provider-specific agent files contain only:

```markdown
# Polaris Managed Repository

Read [POLARIS_RULES.md](POLARIS_RULES.md) before doing any work in this repository.
```

Files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CODEX.md`, and any future provider bootstrap
file. No routing logic, governance, command tables, or doctrine. Provider-specific boot
behavior may be added only if strictly unavoidable and not expressible in `POLARIS_RULES.md`.

### POLARIS_RULES.md

Single shared governance source for the repo. Generated by `polaris init` and maintained as the
authoritative instruction surface. Contents:

- Compact repo overview (2–4 sentences, derived from existing root-level docs at adoption time)
- Temporary Worker Doctrine (D1)
- Repository Memory Doctrine (D2)
- Map-query-only rule (D3)
- Skill command routing table using `<CLUSTER-ID>` notation
- Tracker-agnostic work intake rules (D8)
- Runtime boundaries and role responsibilities
- Links to `.polaris/skills/ROUTING.md` for full routing protocol
- Default role/provider assignment summary

`POLARIS_RULES.md` is SmartDocs-ignored. It is bootstrap governance, not doctrine.

**Size budget:** A lint rule warns if `POLARIS_RULES.md` exceeds ~2000 tokens. Growth beyond
this budget defeats its purpose.

**Maintenance rule:** Any change to Polaris governance requires updating `POLARIS_RULES.md`
only. Agent-specific pointer files are never edited for governance content.

---

## Route Cognition Scaffold Architecture

### What is a route?

A route is a work-owning area of the repository. Not every physical directory. Examples:

- `src/finalize/`
- `src/loop/`
- `src/cognition/`
- `flutter_app/ios/`
- `flutter_app/android/`
- `flutter_app/lib/features/workout_import/`

Excluded from route cognition: `node_modules/`, `dist/`, `build/`, `coverage/`, cache,
generated, and runtime-only folders (governed by `.polarisignore`).

### Cognition Files

Every route receives:

```
<route>/
  POLARIS.md   — route identity, domain, owned paths, governing rules
  SUMMARY.md   — what this area does, key files, dependencies, operational behavior
```

### Trust Metadata

Route cognition carries explicit trust state in frontmatter:

```yaml
# POLARIS.md frontmatter
status: scaffold    # scaffold | reviewed | canonical
confidence: 0.0     # 0.0 – 1.0
```

Lifecycle:
```
scaffold (confidence: 0.0)
  → reviewed (confidence: 0.8)
    → canonical (confidence: 1.0)
```

Workers treat `status: scaffold` cognition as navigational assistance, not authoritative truth.
If a worker's task depends on scaffold-quality cognition, the packet should flag this
explicitly and the worker may escalate rather than assume.

### Template Content

**`POLARIS.md` scaffold template:**
```markdown
---
domain: <detected from map or folder name>
route: <path>
status: scaffold
confidence: 0.0
---
# <folder name>

> Cognition scaffold — not yet reviewed. Update before routing workers here.
```

**`SUMMARY.md` scaffold template:**
```markdown
# Summary: <folder name>

> Scaffold — update with: purpose, key files, what depends on this, what this depends on.
```

### Adoption Debt Tracking

`polaris map validate` reports all routes where cognition status is `scaffold` or missing.
This gives a live adoption debt view without requiring a full ingestion pass.

### Adaptive Route Growth

Route cognition is adaptive. Adoption seeds the obvious routes. Future work may create deeper
routes when:
- a subfolder receives repeated work
- parent cognition becomes bloated
- the subfolder has distinct ownership, validation rules, or operational behavior

Governance:
- **Worker** — may create scaffold route cognition only when packet scope explicitly allows it
- **Librarian** — may refine, promote, merge, or reorganize route cognition during closeout
- **User** — may manually create route cognition at any time

This prevents parent `POLARIS.md` files from becoming monolithic.

---

## SmartDocs Migration Architecture

### Migration Flow (Stage 3)

```
existing docs/**  →  smartdocs/raw/**
                     (status: raw, never auto-promoted, never auto-trusted)
```

### Migration Scope

Migration scope is user-controlled during `polaris init --adopt`. Two modes:

- **Migrate all** — every discovered `.md` moves to `smartdocs/raw/`
- **Selective** — user picks which files to migrate; the rest are automatically added to
  `.smartdocignore`

**Invariant:** After adoption, every `.md` file in the repo is in one of three states:
1. Migrated to `smartdocs/raw/`
2. Explicitly user-excluded in `.smartdocignore`
3. Default-excluded in `.smartdocignore` (agent/governance files — unconditional)

No `.md` file exists in an unknown state relative to SmartDocs after adoption completes.

### Default SmartDocs Exclusions (unconditional)

Added to `.smartdocignore` as part of Stage 1, before any migration decisions:

- `POLARIS_RULES.md`
- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `CODEX.md`
- `**/POLARIS.md`
- `**/SUMMARY.md`
- Any provider bootstrap file at repo root

These files are never presented as migration candidates. "Migrate all" does not include them.

### What Is Not Migrated

- Generated docs (changelogs, API reference output)
- Anything matched by `.smartdocignore`
- Route cognition files

### Stage 4 — One-Time Adoption Skills

Dispatched on demand by a Foreman as bounded worker sessions. Never automatic. Not a gate.

| Skill | Purpose |
|---|---|
| `compress-agent-docs` | Condense existing agent doc content into `POLARIS_RULES.md` |
| `generate-route-cognition` | Fill scaffold templates with substantive content for a route |
| `generate-folder-summaries` | Write or refine `SUMMARY.md` for a set of routes |
| `ingest-raw-docs` | Process `smartdocs/raw/**` for a batch, produce promotion candidates |
| `propose-promotions` | Review raw docs and propose which deserve promotion to `active` |
| `create-yaml-links` | Wire promoted docs into atlas routing |
| `update-summary-md` | Refresh `SUMMARY.md` after a batch of promotions |

---

## Map-Query Architecture

### Rule

Agents may query the map. Agents may not consume map artifacts.

```
polaris map query <path>
```

Returns:
```
domain:       cli
route:        src/cli
taskchain:    polaris-cli
confidence:   0.9
instruction:  src/cli/POLARIS.md
```

The agent reads the local `POLARIS.md` at the returned `instruction` path. It does not load the
map. The map is an index. The index is not the content.

### Prohibited Patterns

These paths must not appear in model-facing instruction surfaces except in prohibition lists:
- `.polaris/map/file-routes.json`
- `.polaris/map/index.json`
- `.polaris/map/needs-review.json`

### Map Artifact Reference Validator

`polaris lint` (or `polaris map validate`) includes a check that scans all model-facing
instruction surfaces for prohibited direct map artifact references.

**Scanned surfaces:**
- `POLARIS_RULES.md`
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CODEX.md`
- `.polaris/skills/**/*.md`
- `**/POLARIS.md`, `**/SUMMARY.md`

**Failure condition:** Any reference to a prohibited path that is not in a prohibition list.
Context-aware: "never read `.polaris/map/file-routes.json`" is not a violation. "Use
`.polaris/map/file-routes.json` for route resolution" is a defect.

**Enforcement:** Runs during `polaris init --adopt` completion and as a CI-safe `polaris lint`
command. Pre-dispatch gate in `polaris loop run`.

---

## Tracker Agnosticism

All skill SKILL.md files, ROUTING.md, chain files, and POLARIS_RULES.md use `<CLUSTER-ID>`
notation, not `POL-###`. The packet compiler is audited for any hardcoded tracker-specific text
in generated instruction content.

---

## Default Role Assignment

### Roles and Staffing

Polaris defines durable roles as job positions. Provider/model assignments are staffing
decisions. The role persists; the model occupying it can change.

Durable roles:
- **Analyst** — analysis, spec generation, impact assessment
- **Foreman** — orchestration, dispatch, loop management
- **Worker** — bounded implementation execution
- **Librarian** — cognition reconciliation, note ingestion, SmartDocs maintenance
- **Medic** — recovery and repair (reserved)

Example staffing:
```
Role: Analyst     Provider: Claude    Model: Sonnet
Role: Foreman     Provider: Codex
Role: Worker      Provider: Copilot
Role: Librarian   Provider: Claude
```

### Initialization Flow

Default role assignment is part of `polaris init` and `polaris init --adopt`. It is guided but
skippable. Three modes:

1. **Interactive** — walks the user through assigning a default provider/model for each role
2. **Config-driven** — if `polaris.config.json` already defines role/provider assignments, uses
   them without overwriting (prompts for confirmation before any change)
3. **Skipped** — advanced users may skip; safe placeholders or documented TODOs are written

### Later Reconfiguration

```
polaris roles configure
```

Re-runs the guided role assignment flow against existing config. May be run at any time.

### Stage 1 Inclusion

Role assignment (or explicit skip with placeholder) is required to complete Stage 1. A repo
without role assignments is runnable only with manual provider specification per dispatch.

---

## Staged Adoption Flow

### Stage 1 — Runnable

Required to begin executing clusters. Completed by `polaris init` or `polaris init --adopt`.

- `polaris.config.json`
- `.polaris/` scaffold (skills, roles, runs, clusters directories)
- Repo-local `polaris` command resolution (devDependency wired to local binary)
- Pointer-only agent files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CODEX.md`)
- `POLARIS_RULES.md` (compact repo overview + all governance rules)
- Default agent/governance files added to `.smartdocignore`
- Default role/provider assignment (or documented skipped role setup)
- Basic skill and runtime wiring

**Invariant:** A repo completing Stage 1 can execute a cluster immediately.

### Stage 2 — Cognition Scaffold

- `POLARIS.md` and `SUMMARY.md` templates written at obvious first-pass routes
- Routes identified from: first-level work surfaces, platform folders, domain folders
- Excluded: generated, vendor, cache, build, runtime-only (governed by `.polarisignore`)
- All cognition files start at `status: scaffold, confidence: 0.0`

### Stage 3 — Documentation Migration

- All existing `.md` files surfaced to user
- User selects: migrate all or selective
- Selected files moved to `smartdocs/raw/` with `status: raw`
- Non-selected files added to `.smartdocignore`
- No auto-promotion; no auto-trust

### Stage 4 — Incremental Cognition Improvement

- One-time adoption skills dispatched on demand by Foreman
- Skills operate on specific routes or doc batches
- May be run in any order, any number of times
- Never a prerequisite for cluster execution

---

## Required Implementation Issues

| Priority | Issue |
|---|---|
| P0 | Update all skill bootloaders: replace `npm run polaris -- skill packet <name>` with `polaris skill packet <name>` |
| P0 | Remove `.polaris/map/file-routes.json` reference from `AGENTS.md` and `CLAUDE.md` |
| P0 | Create `POLARIS_RULES.md` template and generation logic in `polaris init` |
| P0 | Generate pointer-only agent files during `polaris init` / `polaris init --adopt` |
| P1 | Add `POLARIS_RULES.md` and all agent bootstrap files to `.smartdocignore` default exclusions |
| P1 | Replace `POL-###` with `<CLUSTER-ID>` across all skill SKILL.md, chain.md, and ROUTING.md files |
| P1 | Wire `status: scaffold` and `confidence` fields into cognition template generation |
| P1 | Surface scaffold-status routes as adoption debt in `polaris map validate` output |
| P1 | Add guided default role/provider assignment to `polaris init` / `polaris init --adopt` |
| P1 | Add map artifact reference validator to `polaris lint` / `polaris map validate` |
| P2 | Add user-controlled migration scope (migrate-all vs selective) to `polaris init --adopt` |
| P2 | Auto-add non-migrated `.md` files to `.smartdocignore` during adoption |
| P2 | Stabilize `polaris map query` output format as a versioned contract |
| P2 | Audit packet compiler for hardcoded Linear/tracker-specific text in generated instructions |
| P2 | Add `polaris roles configure` command for later role reconfiguration |
| P2 | Add `POLARIS_RULES.md` token budget lint rule (~2000 token warning threshold) |
| P3 | One-time adoption skills scaffold (`compress-agent-docs`, `generate-route-cognition`, etc.) |

---

## Risks and Failure Modes

| Risk | Mitigation |
|---|---|
| `POLARIS_RULES.md` grows large, defeating token-burn purpose | Size budget lint warning at ~2000 tokens |
| Scaffold cognition trusted by workers before review | Packet spec downgrades trust of scaffold routes; worker escalates rather than assumes |
| Map validator has false negatives | `polaris lint` runs as CI check and pre-dispatch gate in `polaris loop run` |
| Adoption skills never run, leaving repo as scaffold indefinitely | `polaris map validate` surfaces adoption debt continuously as a visible metric |
| Migration silently skips important `.md` files | Invariant enforced: every `.md` is migrated or explicitly in `.smartdocignore` |
| Tracker-specific text re-enters skill files | Lint check scans for `POL-###`, `Linear`, and tracker-specific patterns in model-facing files |
| Role assignment skipped, workers fail to dispatch | Stage 1 records explicit skip with placeholder; `polaris loop run` warns if roles are unassigned |
| Parent `POLARIS.md` becomes monolithic as repo grows | Adaptive route growth rules allow Librarian to split and create sub-routes during closeout |

---

## Token-Burn Implications

### Ongoing per-session savings (highest priority)

- Agent files: ~40 lines → 3 lines each → saves 200–400 tokens per session
- `POLARIS_RULES.md` replaces duplicated content across 4+ files → no recurring duplication cost
- Map query replaces full atlas load → potentially thousands of tokens saved per worker session in large repos
- Route-local cognition: worker loads one `POLARIS.md` (~100 tokens) instead of broad context

### One-time adoption cost

- Stage 2 cognition scaffold: template generation — low token cost, primarily file writes
- Stage 3 doc migration: file move operation — zero LLM token cost
- Stage 4 one-time skills: bounded worker sessions dispatched on demand, cost is controlled and not repeated

### Adoption debt cost if skipped

Every worker session in a route with `status: scaffold` cognition incurs a recurring token tax
compensating for missing local context. This tax grows with the number of workers dispatched to
under-cognized routes and is the primary motivation for incremental cognition improvement.
