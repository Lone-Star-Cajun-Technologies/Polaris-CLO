---
name: docs-ingest-step-02-classify-batch
description: Read each file in the batch, inspect front-matter and content signals, and assign exactly one classification from the docs-authority-model.
---

# Step 02 — Classify batch

## Purpose

Assign each file to exactly one classification. Classification determines target directory, authority level, and whether user approval is required before placement.

## Classification table

| Class | Target path | Authority | Approval required |
|---|---|---|---|
| `runtime-summary` | `smartdocs/runtime/summaries/` | low | no |
| `run-report` | `smartdocs/runtime/run-reports/` | low | no |
| `spec-raw` | `smartdocs/raw/` | none | no |
| `spec-active` | `smartdocs/specs/active/` | medium | yes |
| `audit-finding` | `smartdocs/audits/findings/` | medium | no |
| `doctrine-candidate` | `smartdocs/doctrine/candidate/` | low | no |
| `architecture` | `smartdocs/architecture/` | high | yes |
| `decision` | `smartdocs/decisions/` | high | yes |
| `deprecated-noise` | `smartdocs/runtime/generated/` | low | no |

## Classification process (per file)

1. Read the document.
2. Check for explicit Polaris front-matter (`status`, `authority`, `issue`, `classification`). If present and unambiguous: assign classification with **confidence: high**.
3. Otherwise infer from content signals and assign a confidence level:
   - Contains Polaris architectural assertions or "how things should work" → `doctrine-candidate`
   - Structured spec with headings (Spec ID, Status, Purpose, etc.) → `spec-raw`
   - Active spec governing in-flight work referencing an open issue → `spec-active` (flag for approval)
   - Run output, telemetry summaries, session notes → `runtime-summary`
   - Structured run output with metrics → `run-report`
   - Contains `FINDING:` markers or audit-style analysis → `audit-finding`
   - ADR-style decision record → `decision` (flag for approval)
   - Architectural diagrams or structural design context → `architecture` (flag for approval)
   - Low-signal, transient, or auto-generated content → `deprecated-noise`
4. Assign a confidence level per file:
   - **high**: explicit front-matter present, or content matches exactly one signal with no ambiguity
   - **low**: multiple signals match, or content is sparse/unclear
5. Routing by confidence:
   - **high confidence** → auto-place to the classified target in step 04 (no pause, no user input required — except `spec-active`, `architecture`, `decision` which always require approval regardless of confidence)
   - **low confidence** → route to `smartdocs/raw/` as holding area; record reason in telemetry
6. When confidence cannot be determined: default to **low** and route to `smartdocs/raw/`.

## Approval-required classifications

For `spec-active`, `architecture`, and `decision`: do not route automatically regardless of confidence. Surface for user confirmation before step 04 proceeds for those files. Emit:

```text
**needs-input**: <n> file(s) classified as approval-required (<classes>).
Proposed placements:
  <file> → <target> [confidence: high|low]
Confirm placement before step 04 proceeds for these files.
```

High-confidence, non-approval-required files proceed to step 03 immediately without pause.
Low-confidence files are routed to `smartdocs/raw/` and noted in the step 05 summary.

## Scope declarations

```yaml
allowed_files:
  - source files in the batch (read only)
  - smartdocs/specs/active/docs-authority-model.md (reference)
expected_evidence:
  - every file in batch assigned a classification and confidence level
  - approval-required files surfaced before step 04
  - low-confidence files routed to smartdocs/raw/ with telemetry note
  - high-confidence non-approval files proceed automatically
stop_rules:
  - file cannot be read
```

## Artifact update

Update `current-state.json`:
- `current_step_id: 02-classify-batch`
- `classifications: { "<file>": { "class": "<class>", "target": "<path>", "confidence": "high|low", "approval_required": true|false, "auto_place": true|false } }`

Emit `docs-ingest-classified` telemetry event per file.

## Next step

03-conflict-check
