---
source: smartdocs/raw/2026-06-05-adoption-architecture-final-decisions.md
ingest-run-id: polaris-docs-ingest-docs-ingest-2026-06-05-004
classified-as: doctrine-candidate
ingested-at: 2026-06-05T05:21:01.668Z
status: raw
---

<!-- polaris:doctrine-candidate -->
---
status: raw
created: 2026-06-05
title: Adoption Architecture Final Decisions — Route Cognition, Repository Memory, Medic, Librarian, and Drift Management
tags: [adoption, architecture, cognition, medic, librarian, drift, charts, doctrine]
supersedes: smartdocs/raw/2026-06-04-polaris-adoption-architecture-design.md
---

# Adoption Architecture Final Decisions — Route Cognition, Repository Memory, Medic, Librarian, and Drift Management

This document supersedes previous discussions and captures the current architectural direction.

The objective is to minimize recurring token burn while maximizing repository-local institutional memory.

The repository becomes the memory system.

Models remain temporary workers.

---

# Core Principle

Polaris stores institutional memory in repository artifacts, not model memory.

Workers are temporary occupants of durable roles.

A worker should arrive with only the information required to complete the assigned work.

If a worker requires broad repository context, the cognition structure has failed—not the worker.

The goal is not to remember everything.

The goal is to preserve only the information that makes future work:

- cheaper
- safer
- faster
- more accurate

---

# Temporary Worker Doctrine

Every model instance is a temporary occupant of a durable role.

Roles persist.

Model instances are disposable.

Durable roles:

- Analyst
- Foreman
- Worker
- Librarian
- Medic

Workers should know:

- what job they are performing
- what files they may modify
- what route governs the work
- what validation proves completion

Workers should not require repository-wide context.

---

# Route Cognition Model

Route cognition is split into two separate artifacts.

---

## POLARIS.md

POLARIS.md is the route identity and operating manual.

It answers:

- What is this route?
- What type of work happens here?
- What technologies live here?
- What programming languages exist here?
- How architecturally critical is this route?
- What files are important?
- What neighboring routes matter?
- How should workers operate here?

POLARIS.md contains stable route information.

It does not contain current state.

Recommended contents:

- route purpose
- route ownership
- route boundaries
- route criticality
- languages and technologies
- important files
- neighboring routes
- worker guidance
- validation expectations

POLARIS.md is the map.

---

## SUMMARY.md

SUMMARY.md is the route situation report.

It answers:

- What is the current state?
- How healthy is this route?
- What changed recently?
- What should a worker know before starting?

SUMMARY.md should remain concise.

Recommended structure:

- Current State
- Route Health
- Canonical References

SUMMARY.md is the shift handoff.

---

# Route Health

Route Health represents current operational condition.

Example sections:

- Healthy
- Monitoring
- Known Issues
- Recent Treatments
- Improvement Opportunities

The goal is current condition.

Not history.

Not doctrine.

Not implementation detail.

Workers should understand route condition in seconds.

---

# Canonical References

Every SUMMARY.md should contain references to important canonical documents.

Example:

```yaml
canonical_docs:
  - smartdocs/active/runtime/worker-packet-contract.md
  - smartdocs/active/runtime/librarian-closeout.md
  - smartdocs/active/doctrine/temporary-worker-doctrine.md
```

These references are navigation paths.

They are not reading assignments.

Workers do not automatically read linked docs.

Workers retrieve them only when necessary.

---

# Navigation Before Retrieval Doctrine

Links are retrieval paths, not reading assignments.

Workers should not read doctrine, charts, or supporting documents merely because they exist.

Expected behavior:

1. Attempt work
2. Encounter problem
3. Check local guidance
4. Match symptom
5. Retrieve relevant artifact
6. Continue

Never preload all linked documents.

Never load all doctrine.

Never load all charts.

Navigation precedes retrieval.

Retrieval precedes loading.

---

# Repository Memory Doctrine

Polaris stores institutional memory in repository artifacts.

Knowledge should be discoverable through:

- route cognition
- summaries
- SmartDocs
- charts
- telemetry
- runtime artifacts
- commits

Workers should not rely on persistent model memory.

The repository is the memory system.

---

# Medic Role

Medic is a first-class role.

Medic performs diagnosis and repair after worker execution fails.

Medic does not perform normal implementation.

Medic handles exceptions.

Flow:

```
Worker → failure → failed result packet
  → Foreman marks triage required
  → Foreman continues runnable work
  → Medic dispatched
  → diagnosis
  → repair
  → validation
  → chart creation
  → Librarian reconciliation
  → finalize
```

Foreman orchestrates.

Medic repairs.

---

# Chart System

The repository is treated as the patient.

Medic records are called Charts.

Folder:

```
smartdocs/medic/charts/
```

Nothing enters this folder without a valid Chart ID.

Example:

```
CHART-2026-06-04-001
```

Every chart represents a diagnosed failure event and treatment.

---

## Required Chart Metadata

```yaml
chart_id:
cluster_id:
route:
status:
related_charts:
created:
updated:
```

---

## Required Chart Sections

- Problem
- Symptoms
- Root Cause
- Affected Files
- Treatment
- Validation
- Prevention
- When To Read This Chart

Workers should only read charts when symptoms match.

Charts are retrieval targets.

Not preload content.

---

# Chart Relationships

Charts may reference one another.

Supported relationship types:

- same_failure
- edge_case_of
- regression_of
- caused_by
- fixed_by
- supersedes
- duplicate_of

Example:

```yaml
related_charts:
  - chart_id: CHART-2026-06-04-001
    relationship: edge_case_of
```

This is equivalent to updating a patient's medical history.

The goal is to understand recurring failure patterns across time.

---

# Summary and Chart Relationship

SUMMARY.md contains references.

Charts contain detail.

Example SUMMARY.md entry:

```
## Recent Treatments

CHART-2026-06-04-001 — Worker result validation failure repaired and verified.
```

The summary does not contain diagnosis.

The chart contains diagnosis.

The summary is the index.

The chart is the medical record.

---

# Drift Management

Drift detection becomes a formal responsibility.

---

## Medic Drift Responsibilities

Medic may detect drift.

Medic does not resolve drift.

Medic records observations.

Examples:

- summary_outdated
- canon_mismatch
- route_guidance_outdated
- missing_documentation
- invalid_reference

Chart metadata may contain:

```yaml
drift_observations:
  - summary_outdated
  - canon_mismatch
```

Medic produces evidence.

Medic does not update repository memory.

---

## Librarian Drift Responsibilities

Librarian is responsible for repository memory reconciliation.

Librarian resolves drift.

After every completed run the Librarian reviews:

- worker results
- medic results
- charts
- route cognition
- summaries
- linked canon
- repository changes

Questions:

- Does SUMMARY.md still describe reality?
- Does POLARIS.md still describe the route?
- Did behavior change?
- Did dependencies change?
- Did guidance become stale?
- Did canon become inaccurate?
- Did a chart reveal reusable knowledge?

Actions:

- update SUMMARY.md
- update POLARIS.md
- update canonical references
- update route health
- create or update SmartDocs
- link charts
- reconcile repository memory

---

# Librarian Requirement

Keep Librarian reconciliation required.

Implementation complete does not equal run complete.

Run complete requires:

1. Worker completion
2. Result packet
3. Medic completion (if required)
4. Librarian reconciliation
5. Cognition updates
6. Finalization

---

## No Librarian Provider Configured

If no dedicated Librarian provider exists:

Foreman may dispatch a Librarian subagent.

Foreman must not personally perform Librarian work.

Provider sharing is allowed.

Role authority sharing is not.

A provider may occupy multiple roles.

Role authority does not merge.

---

# SmartDocs Responsibilities

SmartDocs contains:

- doctrine
- architecture decisions
- long-form guidance
- promoted charts
- reusable repair knowledge

Charts begin as raw artifacts.

Librarian determines:

- remain raw
- promote
- merge
- supersede
- archive

---

# Organizational Analogy

| Role/Artifact | Analogy |
|---|---|
| POLARIS.md | Job Description |
| SUMMARY.md | Shift Handoff |
| Medic Chart | Medical Record / Incident Report |
| SmartDocs | Policies and Procedures |
| Worker | Technician |
| Medic | Specialist |
| Librarian | Records Steward |
| Foreman | Dispatcher |
| Repository | Patient |

---

# Design Goal

The objective is repository memory, not model memory.

The repository should become progressively easier to work in because every run leaves behind a small amount of targeted, reusable knowledge.

Knowledge should be:

- lightweight
- surgical
- route-local
- conditionally retrieved
- linked
- auditable

Never preload broad context when targeted retrieval is possible.

The repository should teach future workers how to succeed without forcing them to relive the entire history of the project.
