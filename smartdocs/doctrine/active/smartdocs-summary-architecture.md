---
kind: doctrine
status: active
promoted: 2026-05-30
source: smartdocs/raw/smartdocs-summary-architecture.md
doc-type: doctrine
implements: ""
related: ""
supersedes: ""
superseded_by: ""
depends_on: ""
validates: ""
source_paths: src/smartdocs-engine/validate-instructions.ts,src/smartdocs-engine/seed-instructions.ts
ingest-run-id: polaris-docs-ingest-docs-ingest-2026-05-28-003
classified-as: doctrine-candidate
linked-map-area: .codex/skills/polaris-run/chain.md
ingested-at: 2026-05-28T06:23:01.681Z
---

# Smart Docs Summary Architecture

> **Status:** Canonical  
> **Source:** Spawned from POL-135 — ANALYZE: Define Smart Docs summary architecture and folder cognition model  
> **Implemented by:** POL-136 (clusters POL-137 through POL-140)

---

## 1. File Responsibility Matrix

| File | Role | Authority | Scope |
|------|------|-----------|-------|
| `POLARIS.md` | Route-local operating doctrine: responsibilities, boundaries, invariants, commands/workflows, safety rules, related canon | Authoritative for route operating guidance | Folder-level |
| `SUMMARY.md` | Informational current-state memory: current behavior, synthesized recent changes, known gaps, current caveats, linked canonical sources | **Informational only** — never authoritative | Folder-level |
| `smartdocs/doctrine/active/*.md` | Behavioral canon | Authoritative | Repo-wide |
| Implementation notes | In-code comments, ADRs | Authoritative at point of origin | File-level |

---

## 2. POLARIS.md Responsibility Boundaries

### POLARIS.md MUST contain

- **Purpose** — one paragraph describing what this folder does
- **Responsibilities and boundaries** — what this route owns and where handoffs begin
- **Invariants and safety rules** — non-negotiable operating constraints
- **Commands/workflows** — route-local operational commands and runbook behaviors
- **What belongs here / does not belong here** — explicit scope boundaries
- **Read before editing / related canon** — links to authoritative doctrine/spec sources
- **Related routes** — atlas route pointer to sibling or parent folders

### POLARIS.md MUST NOT contain

- Doctrine (belongs in `smartdocs/doctrine/`)
- Architecture specs (belongs in `smartdocs/specs/`)
- Session history or run summaries
- Compressed knowledge that could drift from implementation

**Enforcement:** `polaris docs validate-instructions` surfaces POLARIS.md files that violate these boundaries. The seed tool enforces them at generation time via template sections.

---

## 3. SUMMARY.md Responsibility Boundaries

### SUMMARY.md MUST contain (standard schema)

| Section | Description |
|---------|-------------|
| **Purpose** | One-line statement of what this folder does |
| **Core Concepts** | 3–7 key concepts a reader needs before diving into source |
| **Architectural Role** | How this folder fits into the larger system |
| **Key Constraints** | The most important non-obvious behavioral limits |
| **Important Relationships** | Upstream/downstream dependencies on other folders |
| **Current State** | What is implemented, what is not yet, known gaps |
| **Recent Changes (Synthesized)** | Recent run/changelog facts distilled into current state (not diary entries) |
| **Current Caveats** | Active caveats and temporary constraints that affect current understanding |
| **Known Drift** | Places where the summary may be stale (honesty field) |
| **Linked Canonical Sources** | Links to spec files, doctrine, POLARIS.md |

### SUMMARY.md MUST NOT contain

- Rules (belongs in POLARIS.md)
- Behavioral assertions using `must`/`never`/`always` (risks doctrine bleed)
- File inventories (belongs in POLARIS.md "What belongs here")
- Diary-style run logs or append-only changelog history
- Verbatim copies of stable operating doctrine from POLARIS.md

**Governance:** SUMMARY.md that contains modal verbs (`must`/`never`/`always`) referencing implementation behavior must be flagged as a **doctrine bleed risk** by the validation tool.

---

## 4. Traversal Model

The canonical agent and developer traversal flow is:

```
POLARIS.md  →  SUMMARY.md  →  linked doctrine/specs  →  implementation details
```

| Layer | Tells you | Authority |
|-------|-----------|-----------|
| `POLARIS.md` | WHERE things are and WHAT the rules are | Authoritative for routing and editing |
| `SUMMARY.md` | WHAT the folder understands about itself (compressed) | Informational only |
| `smartdocs/doctrine/active/` | WHY things work the way they do | Authoritative |
| `smartdocs/specs/` | Architecture decisions | Authoritative |
| Implementation | HOW things actually work | Authoritative at point of origin |

Agents must not short-circuit this traversal by treating SUMMARY.md as a substitute for doctrine or spec files. When SUMMARY.md conflicts with a linked canonical source, the canonical source wins without exception.

---

## 5. Authority Model

| Source | Authoritative for | Informational for |
|--------|-------------------|-------------------|
| `POLARIS.md` | Routing, editing rules, file ownership | Overview of folder purpose |
| `SUMMARY.md` | **Nothing** (always informational) | Compressed context, drift signals |
| `smartdocs/doctrine/active/` | All behavioral canon | N/A |
| `smartdocs/specs/` | Architecture decisions | Background context |

**Critical rule:** SUMMARY.md is **always informational**. It must never be treated as authoritative by any tooling, canon-check, or ingest pipeline. This is a hard constraint, not a convention.

---

## 6. Governance Rules

1. **Ingest exclusion** — SUMMARY.md is excluded from Smart Docs ingest. It is an endpoint artifact.
2. **Doctrine pipeline exclusion** — SUMMARY.md must not enter the doctrine pipeline.
3. **Doctrine bleed detection** — SUMMARY.md containing modal verbs (`must`/`never`/`always`) referencing implementation behavior must be flagged as a doctrine bleed risk.
4. **Authorship** — SUMMARY.md is human-curated by default. Partially-generated drafts are acceptable if clearly marked with `<!-- polaris:draft -->`.
5. **No promotion lifecycle** — Promotion governance does not apply to SUMMARY.md. It has no promotion lifecycle; it does not graduate to canon.
6. **Canon-check handling** — SUMMARY.md must be treated as informational-only by the canon-check tool. It must not be evaluated for authoritative content.
7. **Evidence-driven update scope** — reconciliation may update only `POLARIS.md`, only `SUMMARY.md`, both, or neither based on evidence.
8. **Summary synthesis rule** — recent-run/changelog material may appear in `SUMMARY.md` only when synthesized into current state.
9. **No doctrine duplication** — stable operating rules belong in `POLARIS.md` and should be referenced, not duplicated verbatim, in `SUMMARY.md`.

---

## 7. Folder Cognition Scaling

| Repo type | POLARIS.md coverage | SUMMARY.md coverage |
|-----------|--------------------|--------------------|
| Small repo (< 10 source dirs) | All source dirs | Optional; top-level only |
| Standard repo | All source dirs | Core domain dirs |
| Large repo / monorepo | All leaf dirs | All dirs with ≥ 5 files |
| Multi-agent system | All dirs including `.codex/` | All dirs |
| Nested domains | Per-domain POLARIS.md | Per-domain SUMMARY.md |

For multi-agent systems (such as Polaris itself), SUMMARY.md coverage of all directories is recommended. Agent traversal performance degrades when folder context requires reading many source files; a well-maintained SUMMARY.md reduces that cost significantly while keeping the authority boundary clear.

---

## 8. Migration Recommendations for Existing Folders

For repos with existing POLARIS.md files:

1. **Audit** — Run `polaris docs validate-instructions` to surface overloaded POLARIS.md files that contain doctrine-like or spec-like content.
2. **Extract** — Any POLARIS.md containing compressed knowledge or behavioral assertions: extract to SUMMARY.md (or to `smartdocs/doctrine/` if the content is genuinely canonical).
3. **Generate** — Produce missing SUMMARY.md files with `polaris docs seed-summary --all` (implemented in POL-139).
4. **Review** — Review generated drafts; remove `<!-- polaris:draft -->` markers only after human review confirms accuracy.
5. **Validate** — Run `polaris docs validate-instructions` again to confirm POLARIS.md files are clean after extraction.

**Order matters:** Steps 1–2 must complete before step 3. Generating SUMMARY.md from an overloaded POLARIS.md would bake the overload into the summary.

---

## 9. Generated Region Convention

Polaris-generated `POLARIS.md` and `SUMMARY.md` files wrap their machine-populated body in `<!-- BEGIN POLARIS GENERATED -->` and `<!-- END POLARIS GENERATED -->` markers.

- The content between these markers is the **machine-owned region**. It may be regenerated by `polaris docs seed-instructions` / `polaris docs seed-summary` or by the adopt-canon librarian flow.
- Content outside the markers is **human-owned**. The generator must not strip or overwrite it.
- `polaris docs validate-instructions` applies role-boundary and section checks only inside the generated region. Human-maintained extensions outside the markers are not evaluated for canonical section compliance.

`<!-- polaris:draft -->` remains the whole-file lifecycle marker. Removing the draft marker promotes the file, but the generated region markers remain so the machine-owned portion can still be regenerated safely.

### Optional `## Route model` extension

A `## Route model` section may be added as a **human-maintained extension outside the generated region**. It is not part of the machine-generated seven-section `POLARIS.md` template and does not need to be present in every route. It is a valid place for route-specific execution conventions that are not yet ready or appropriate to canonize in the seven-section template. Validation must allow it to exist outside the generated region without raising role-boundary errors.

---

## Linked Canonical Sources

- `smartdocs/specs/polaris-architecture-spec.md` — loop/map/finalize architecture
- `smartdocs/specs/polaris-implementation-plan.md` — failure modes, recommendation, implementation tree
- `smartdocs/specs/polaris-dispatch-contract.md` — subagent dispatch boundary contract
- `.polaris/skills/polaris-run/chain.md` — implementation cluster execution model
