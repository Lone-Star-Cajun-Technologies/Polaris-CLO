---
name: polaris-catalog-step-04
description: Classify documents in smartdocs/raw/, auto-place high-confidence files via CLI, and surface or hold low-confidence files based on mode.
---

# Step 04 — Classify and place

## Purpose

Process all files enumerated in `current-state.json.raw_files`. Classify each one,
auto-place high-confidence results via the Polaris CLI, and handle low-confidence files
according to the session mode (`packet.unattended`).

If `raw_files` is empty: record as no-op and proceed to step 05.

## Classification table

| Class | Target path | Auto-place on high confidence |
|---|---|---|
| `runtime-summary` | `smartdocs/runtime/summaries/` | yes |
| `run-report` | `smartdocs/runtime/run-reports/` | yes |
| `spec-raw` | `smartdocs/raw/` | no-op (already there) |
| `spec-active` | `smartdocs/specs/active/` | yes |
| `audit-finding` | `smartdocs/audits/findings/` | yes |
| `doctrine-candidate` | `smartdocs/doctrine/candidate/` | yes |
| `architecture` | `smartdocs/architecture/` | yes |
| `decision` | `smartdocs/decisions/` | yes |
| `deprecated-noise` | `smartdocs/runtime/generated/` | yes |

**Confidence is the only gate.** High confidence → place regardless of authority level.
Low confidence → ask user (interactive) or leave in raw (unattended).

## Classification process (per file)

1. Read the document.
2. Check for explicit Polaris front-matter (`status`, `authority`, `classification`).
   If present and unambiguous → **confidence: high**.
3. Otherwise infer from content signals:
   - Polaris architectural assertions / "how things should work" → `doctrine-candidate`
   - Structured spec with Spec ID, Status, Purpose headings → `spec-active`
   - Run output, telemetry summaries, session notes → `runtime-summary`
   - Structured run output with metrics → `run-report`
   - `FINDING:` markers or audit-style analysis → `audit-finding`
   - ADR-style decision record → `decision`
   - Architectural diagrams or structural design context → `architecture`
   - Low-signal, transient, or auto-generated → `deprecated-noise`
   - Unclear or multiple signals → low confidence, class remains `spec-raw`
4. Assign confidence:
   - **high**: explicit front-matter, or exactly one signal matches unambiguously
   - **low**: multiple signals, sparse content, or no clear signal

## Placement actions

### High confidence

Run the appropriate CLI command immediately. Do not pause for user input.

```bash
# All classes except doctrine-candidate:
polaris docs ingest --file <path>

# doctrine-candidate:
polaris doctrine draft <path>
```

Record in `docs_placed`.

### Low confidence — interactive mode (`packet.unattended: false`)

Surface each file to the user:

```text
needs-input: <filename>
Inferred class: <class> [confidence: low]
Reason: <why confidence is low>
Where should this go? Options:
  1. <class> → <target>  (inferred)
  2. Leave in smartdocs/raw/
  3. [other class]
```

Wait for user response before placing. Record the user's decision in `docs_placed` or
`docs_held` accordingly.

### Low confidence — unattended mode (`packet.unattended: true`)

Leave the file in `smartdocs/raw/`. Record in `docs_held` with reason. Do not block.
Do not fail the run.

## After batch

Run map update:

```bash
polaris map update --changed
```

## Hard rules

- Use the CLI for all file moves. Never use `mv` or `cp` directly on `smartdocs/` files.
- If the CLI rejects a file as ignored (`POLARIS.md`, `SUMMARY.md`, `README.md`): leave in
  raw, record as ineligible in `docs_held`.
- If a target path collision is detected: record as a blocker for that file. Do not
  overwrite without explicit user approval.
- Source files already in `smartdocs/` sub-directories other than `raw/` are out of scope
  for this step. Skip them.

## Output

```yaml
docs_placed: [{ file: "<source>", target: "<path>", class: "<class>", confidence: "high" }]
docs_held: [{ file: "<source>", reason: "<low-confidence|ineligible|collision>", detail: "..." }]
```

## Next step

05-catalog-commit
