---
kind: doctrine
status: active
candidate-since: 2026-05-28
source: smartdocs/raw/smartdocs-summary-architecture.md
doc-type: doctrine
confidence: 0.95
recommended-action: promote
overlap-analysis: No overlap with existing active doctrine. Establishes POLARIS.md/SUMMARY.md responsibility boundaries, the traversal model, and SUMMARY.md authority constraints (always informational). Directly governs behavior of seed-instructions, seed-summary, and validate-instructions tooling.
implements: ""
related: ""
supersedes: ""
superseded_by: ""
depends_on: ""
validates: ""
source_paths: src/smartdocs-engine/validate-instructions.ts,src/smartdocs-engine/seed-instructions.ts
---

# Smart Docs Summary Architecture

> **Status:** Canonical  
> **Source:** Spawned from POL-135 — ANALYZE: Define Smart Docs summary architecture and folder cognition model  
> **Implemented by:** POL-136 (clusters POL-137 through POL-140)

---

## 1. File Responsibility Matrix

| File | Role | Authority | Scope |
|------|------|-----------|-------|
| `POLARIS.md` | Folder front door: navigation, local rules, structure | Authoritative for routing and editing constraints | Folder-level |
| `SUMMARY.md` | Compressed doctrine snapshot for this folder/domain | **Informational only** — never authoritative | Folder-level |
| `smartdocs/doctrine/active/*.md` | Behavioral canon | Authoritative | Repo-wide |
| Implementation notes | In-code comments, ADRs | Authoritative at point of origin | File-level |

---

## 2. POLARIS.md Responsibility Boundaries

### POLARIS.md MUST contain

- **Purpose** — one paragraph describing what this folder does
- **What belongs here** — bulleted file list of contents
- **What does not belong here** — explicit exclusions
- **Editing rules** — behavioral constraints for agents and humans
- **Architecture assumptions** — what the code assumes about the world
- **Read before editing** — links to canonical sources (doctrine, specs)
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
| **Known Drift** | Places where the summary may be stale (honesty field) |
| **Linked Canonical Sources** | Links to spec files, doctrine, POLARIS.md |

### SUMMARY.md MUST NOT contain

- Rules (belongs in POLARIS.md)
- Behavioral assertions using `must`/`never`/`always` (risks doctrine bleed)
- File inventories (belongs in POLARIS.md "What belongs here")

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

## Linked Canonical Sources

- `smartdocs/specs/polaris-architecture-spec.md` — loop/map/finalize architecture
- `smartdocs/specs/polaris-implementation-plan.md` — failure modes, recommendation, implementation tree
- `smartdocs/specs/polaris-dispatch-contract.md` — subagent dispatch boundary contract
- `.polaris/skills/polaris-run/chain.md` — implementation cluster execution model
