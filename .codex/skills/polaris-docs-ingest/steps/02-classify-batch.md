---
name: polaris-docs-ingest-step-02-classify-batch
description: Read each file in the batch, inspect front-matter and content signals, and assign exactly one classification from the docs-authority-model.
---

# Step 02 — Classify batch

## Purpose

Assign each file to exactly one classification. Classification determines target directory, authority level, and whether user approval is required before placement.

## Classification table

| Class | Target path | Authority | Approval required |
|---|---|---|---|
| `runtime-summary` | `Polaris-Docs/docs/runtime/summaries/` | low | no |
| `run-report` | `Polaris-Docs/docs/runtime/run-reports/` | low | no |
| `spec-raw` | `Polaris-Docs/docs/specs/raw/` | none | no |
| `spec-active` | `Polaris-Docs/docs/specs/active/` | medium | yes |
| `audit-finding` | `Polaris-Docs/docs/audits/findings/` | medium | no |
| `doctrine-candidate` | `Polaris-Docs/docs/doctrine/candidate/` | low | no (active/ requires approval) |
| `architecture` | `Polaris-Docs/docs/architecture/` | high | yes |
| `decision` | `Polaris-Docs/docs/decisions/` | high | yes |
| `deprecated-noise` | `Polaris-Docs/docs/runtime/generated/` | low | no |

## Classification process (per file)

1. Read the document.
2. Check for explicit Polaris front-matter (`status`, `authority`, `issue`, `classification`). If present and unambiguous: use it.
3. Otherwise infer from content signals:
   - Contains Polaris architectural assertions or "how things should work" → `doctrine-candidate`
   - Structured spec with headings (Spec ID, Status, Purpose, etc.) → `spec-raw`
   - Active spec governing in-flight work referencing an open issue → `spec-active` (flag for approval)
   - Run output, telemetry summaries, session notes → `runtime-summary`
   - Structured run output with metrics → `run-report`
   - Contains `FINDING:` markers or audit-style analysis → `audit-finding`
   - ADR-style decision record → `decision` (flag for approval)
   - Architectural diagrams or structural design context → `architecture` (flag for approval)
   - Low-signal, transient, or auto-generated content → `deprecated-noise`
4. When ambiguous: default to `spec-raw`. Record ambiguity in telemetry.

## Approval-required classifications

For `spec-active`, `architecture`, and `decision`: do not route automatically. Surface for user confirmation before step 04 proceeds for those files. Emit:

```text
**needs-input**: <n> file(s) classified as approval-required (<classes>).
Proposed placements:
  <file> → <target>
Confirm placement before step 04 proceeds for these files.
```

Files that do not require approval proceed to step 03 immediately. Approval-required files are held until confirmation.

## Scope declarations

```yaml
allowed_files:
  - source files in the batch (read only)
  - Polaris-Docs/docs/specs/active/docs-authority-model.md (reference)
expected_evidence:
  - every file in batch assigned a classification
  - approval-required files surfaced before step 04
  - ambiguous files defaulted to spec-raw with telemetry note
stop_rules:
  - file cannot be read
```

## Artifact update

Update `current-state.json`:
- `current_step_id: 02-classify-batch`
- `classifications: { "<file>": { "class": "<class>", "target": "<path>", "approval_required": true|false } }`

Emit `docs-ingest-classified` telemetry event per file.

## Next step

03-conflict-check
