# Polaris Docs Authority Model and `polaris docs ingest` Spec

**Status:** active spec  
**Issue:** POL-47 (child of POL-42)  
**Created:** 2026-05-23

---

## 1. Purpose

This spec defines:

1. The target docs directory structure and authority model.
2. The `polaris docs ingest` command: inputs, classification, conflict detection, telemetry.
3. The clustered ingest design for large repos.
4. Markdown placement governance rules and enforcement points.
5. The migration path from the current `docs/Polaris/` layout to the target model.

---

## 2. Directory Authority Model

```text
docs/
  raw/                        # unclassified drops — agents may write here freely
  runtime/
    summaries/                # run-generated summaries (low authority)
    run-reports/              # structured run output (low authority)
    generated/                # misc machine-generated content (low authority)
  specs/
    raw/                      # specs not yet reviewed
    active/                   # specs governing current or in-flight work
    implemented/              # specs whose implementation is confirmed complete
    superseded/               # specs replaced by a newer spec
  audits/
    raw/                      # unprocessed audit findings
    findings/                 # reviewed audit findings
    resolved/                 # findings confirmed closed
  doctrine/
    raw/                      # agent-generated statements not yet reviewed
    candidate/                # proposed doctrine awaiting approval
    active/                   # approved doctrine governing current canon
    deprecated/               # retired doctrine (kept for provenance)
  architecture/               # accepted structural design context (stable)
  decisions/                  # ADRs and point-in-time design decisions
```

### Authority Levels

| Area | Authority | Who may write | Promotion path |
|---|---|---|---|
| `raw/` | none | any agent freely | manual or `docs ingest` classification |
| `runtime/` | low | polaris-run, polaris-finalize | no promotion; informational only |
| `specs/raw/` | none | any agent | remains in `specs/raw/`; user review moves to `specs/active/` |
| `specs/active/` | medium | approved work only | moved to `implemented/` or `superseded/` |
| `audits/` | medium | analyze sessions | findings moved to `resolved/` on close |
| `doctrine/raw/` | none | any agent | `docs ingest` promotes to `doctrine/candidate/` |
| `doctrine/candidate/` | low | docs ingest | user approval required to reach `active/` |
| `doctrine/active/` | high | user-approved only | only user approval moves or deprecates |
| `architecture/` | high | user-approved only | explicit ADR process |
| `decisions/` | high | user-approved only | explicit ADR process |

**Key rule:** agents may generate docs freely into `raw/` and `runtime/` areas. Agents must not silently promote to `doctrine/active/`, `architecture/`, or `decisions/`. Promotion to those areas requires explicit user approval.

---

## 3. `polaris docs ingest` Command Spec

### 3.1 Purpose

Classify, route, and link one or more documents from `docs/raw/` (or a specified source path) into the correct authority bucket.

### 3.2 Invocation

```bash
polaris docs ingest [--file <path>] [--batch <cluster-id>] [--dry-run]
```

| Flag | Meaning |
|---|---|
| `--file <path>` | Ingest a single file |
| `--batch <cluster-id>` | Process the file list for a named ingest cluster |
| `--dry-run` | Classify and report; do not move files or update map |

Without flags, ingest processes the next pending batch registered in `current-state.json`.

### 3.3 Input

- Source documents: files in `docs/raw/` or specified paths.
- Polaris map: `.polaris/map/index.json` — for linking ingested docs back to code areas.
- Current-state: `.taskchain_artifacts/polaris-run/current-state.json` — for provenance links.
- Instruction files: indexed via `instructionFile` map entries — for linking docs to governed areas.

### 3.4 Classification

Each document is classified into exactly one of:

| Class | Target path |
|---|---|
| `runtime-summary` | `docs/runtime/summaries/` |
| `run-report` | `docs/runtime/run-reports/` |
| `spec-raw` | `docs/specs/raw/` |
| `spec-active` | `docs/specs/active/` (requires user approval) |
| `audit-finding` | `docs/audits/findings/` |
| `doctrine-candidate` | `docs/doctrine/candidate/` |
| `architecture` | `docs/architecture/` (requires user approval) |
| `decision` | `docs/decisions/` (requires user approval) |
| `deprecated-noise` | `docs/runtime/generated/` (or deletion) |

Classification is performed by content analysis. The agent should:

1. Read the document.
2. Check for explicit Polaris front-matter (`status`, `authority`, `issue`).
3. Infer class from content signals (spec headings, audit-finding markers, doctrine assertions, etc.).
4. When ambiguous, default to `spec-raw` and note the ambiguity in telemetry.

### 3.5 Conflict Detection

Before finalizing placement, ingest must compare the incoming document against:

- Existing `doctrine/active/` files — check for contradicting assertions.
- Existing `specs/active/` files — check for overlapping scope.
- Existing instruction files linked to the same code area.

Conflict signals:

| Signal | Action |
|---|---|
| Direct contradiction of active doctrine | Halt, report conflict, require user resolution |
| Overlapping spec scope | Flag as candidate supersede; surface to user |
| Stale assumption (references old API/structure) | Annotate doc; emit `stale-assumption` telemetry event |
| No conflicts | Proceed to placement |

Ingest must never silently suppress a conflict.

### 3.6 Candidate Doctrine Proposal

When a document is classified as `doctrine-candidate`:

1. Move to `docs/doctrine/candidate/`.
2. Add front-matter: `status: candidate`, `candidate-since: <date>`, `source: <original-path>`.
3. Emit `doctrine-candidate-proposed` telemetry event.
4. Do NOT promote to `doctrine/active/` without explicit user approval (`polaris doctrine promote`).

### 3.7 Linking

After placement, ingest links the doc in the Polaris map:

- Add a `docs` entry to relevant map nodes (matched by code-area heuristics or explicit `--area` flag).
- Link to originating run ID if available.
- Link to related instruction file if one governs the same area.
- Preserve `originalPath` as provenance metadata (not active routing).

Provenance record written alongside ingested doc:

```json
{
  "currentPath": "docs/specs/raw/some-spec.md",
  "originalPath": "docs/raw/some-spec.md",
  "ingestedAt": "<ISO timestamp>",
  "ingestRunId": "<run-id>",
  "ingestClusterId": "<cluster-id or null>",
  "relatedRunId": "<polaris run id or null>",
  "relatedIssue": "<Linear issue ID or null>",
  "classifiedAs": "spec-raw",
  "conflictsDetected": false
}
```

### 3.8 Output

On completion, ingest emits:

- Placement summary to stdout (or `--dry-run` report).
- Updated map entries.
- Provenance records per ingested file.
- Telemetry events (see §3.9).

### 3.9 Telemetry Events

| Event | Trigger |
|---|---|
| `docs-ingest-start` | Begin processing a batch |
| `docs-ingest-classified` | Each file classified |
| `docs-ingest-conflict-detected` | Conflict found against active doctrine/spec |
| `doctrine-candidate-proposed` | Doc promoted to `doctrine/candidate/` |
| `docs-ingest-stale-assumption` | Stale assumption annotated |
| `docs-ingest-complete` | Batch done |

Required fields on every event: `event`, `run_id`, `timestamp`, `file`.

---

## 4. Clustered Ingest Design

For large repos, ingest must be bounded. Polaris must not ingest hundreds of docs in a single session.

### 4.1 Cluster Size

Default: 3–4 files per ingest cluster. Configurable in `polaris.config.json`:

```json
{
  "docs": {
    "ingestBatchSize": 4
  }
}
```

### 4.2 Cluster Registration

Before running ingest, generate a cluster manifest:

```text
.polaris/docs-ingest/
  cluster-001.json   → files 1–4
  cluster-002.json   → files 5–8
  ...
```

Each cluster file:

```json
{
  "clusterId": "docs-ingest-cluster-001",
  "status": "pending",
  "files": [
    "docs/raw/foo.md",
    "docs/raw/bar.md",
    "docs/raw/baz.md"
  ],
  "createdAt": "<ISO timestamp>"
}
```

### 4.3 Execution

Each cluster is executable in a fresh session:

```bash
polaris docs ingest --batch docs-ingest-cluster-001
```

After completion the cluster record is updated to `status: complete` with a `completedAt` timestamp.

### 4.4 Session Stop Rule

Ingest follows polaris-run context budget rules:

- One cluster per session.
- Stop after cluster completes.
- Bootstrap packet guides the next session to the next pending cluster.

---

## 5. Markdown Placement Governance

### 5.1 Default Rule

> Agents may generate markdown freely, but they may not scatter markdown.

Agent-generated markdown must land in `docs/raw/` before being routed elsewhere by `docs ingest`.

### 5.2 Allowed Exceptions

The following markdown files may exist outside the `docs/` hierarchy:

| File | Allowed location |
|---|---|
| `README.md` | Any directory root |
| `CHANGELOG.md` | Repo root (if project uses it) |
| `LICENSE` / license text | Repo root |
| `POLARIS.md` | Any directory root |
| `INSTRUCTIONS.md` | Any directory root |
| Agent instruction files | `.agents/claude/*.md`, `.agents/codex/*.md`, `.codex/**/*.md` |
| `.claude/CLAUDE.md` | Repo root `.claude/` |

### 5.3 Enforcement Points

| Enforcement point | Mechanism |
|---|---|
| `polaris-run` pre-flight | Check `--changed` files against allowed exceptions; warn if agent dropped markdown outside allowed locations |
| `polaris-finalize` | Run placement check before PR; block merge guidance if stray markdown detected |
| `polaris docs validate` (future) | Explicit audit of all markdown outside `docs/` vs allowed-exceptions list |
| CI/linting (optional) | Script to surface stray markdown at review time |

Enforcement behavior: warn and surface; do not silently move files. The agent reports the violation and suggests `polaris docs ingest` as the remedy.

---

## 6. Migration Path from Current `docs/Polaris/` Layout

### 6.1 Current Layout

```text
docs/
  Polaris/
    spec/
      current-state-schema.md
      execution-adapter-architecture.md
      local-instructions-layer.md
      polaris-implementation-plan.md
    planning/
      cluster-map.md
  spec/
    current-state-schema.md
    polaris-implementation-plan.md
    taskchain-authoring.md
    taskchain-format.md
  planning/
    cluster-map.md
```

### 6.2 Conflicts and Gaps

| Issue | Detail |
|---|---|
| Duplicate files | `docs/spec/` and `docs/Polaris/spec/` contain overlapping files (`current-state-schema.md`, `polaris-implementation-plan.md`). One set will become authoritative; the other is provenance. |
| No authority levels | All specs live in a flat `spec/` directory. No distinction between active, implemented, or superseded. |
| No `raw/` drop zone | Agents have no canonical inbox for generated docs. |
| No doctrine structure | No separation of runtime observations from approved doctrine. |
| No provenance records | No metadata linking specs to originating runs/issues. |

### 6.3 Recommended Migration Sequence

This migration is executed by `polaris docs migrate` (a separate follow-on implementation). This spec defines the target state; the migration plan is:

1. **Establish target structure.** Create the directory tree from §2 (stub with `.gitkeep` files where needed).
2. **Classify existing docs.** For each file in `docs/Polaris/spec/` and `docs/spec/`:
   - Confirm whether it is a spec, an architecture doc, or planning artifact.
   - Assign to `specs/active/` or `specs/implemented/` based on current implementation status.
3. **Resolve duplicates.** When a file exists in both `docs/spec/` and `docs/Polaris/spec/`, keep the most recent/authoritative version in the target path; move the other to `docs/audits/raw/` with a note.
4. **Migrate planning docs.** `docs/Polaris/planning/cluster-map.md` and `docs/planning/cluster-map.md` → `docs/runtime/run-reports/` (they are historical planning artifacts, not active specs).
5. **Write provenance records.** For each migrated file, write a `<filename>.provenance.json` in the same target directory.
6. **Update map.** Run `polaris map update --changed` after migration completes.
7. **Do not delete original files** until the migration run's PR is merged and the map is confirmed updated.

### 6.4 Files Requiring User Decision

The following files require explicit classification before migration can proceed automatically:

| File | Ambiguity |
|---|---|
| `docs/spec/taskchain-authoring.md` | May be active doctrine or a superseded spec — requires owner review |
| `docs/spec/taskchain-format.md` | Same ambiguity |
| `docs/Polaris/spec/execution-adapter-architecture.md` | May already be superseded by newer architecture |

These are flagged as `analyze-boundary` items: ingest should surface them but not classify them without user input.

---

## 7. Relationship to Other Polaris Layers

| Layer | Relationship |
|---|---|
| Polaris map (`polaris map`) | Ingest adds `docs` entries to map nodes; map is source of truth for code-area linkage |
| Instruction files (`INSTRUCTIONS.md`, `POLARIS.md`) | Ingest links docs to the instruction file governing the same area |
| telemetry / current-state | Ingest emits structured telemetry; run IDs preserved as provenance |
| `polaris finalize` | Finalize triggers ingest for any new `docs/raw/` files generated during the run |
| `polaris loop continue` | Enforces single-cluster-per-session boundary for ingest sessions |

---

## 8. Future Commands (Out of Scope for This Spec)

These commands are identified in POL-42 but not specified here:

- `polaris docs migrate` — one-time backfill for existing repos
- `polaris docs validate` — audit markdown placement
- `polaris doctrine draft` / `polaris doctrine promote` / `polaris doctrine deprecate`
- `polaris canon diff` / `polaris canon approve` / `polaris canon deprecate`
- `polaris map query --include-docs`

Each will have its own spec child when scheduled.
