# clusters.json — Cluster Topology Format

`clusters.json` is the local cluster topology artifact produced by **polaris-analyze** during step 05.

It stores execution groupings, dependencies, and session types for a work unit.

**This is not a skill traversal contract.** Skill traversal contracts live in `chain.md` and `chain.json`. `clusters.json` describes what work to execute, not how the skill executes it.

---

## Location

```
.polaris/clusters/<source-id>/clusters.json
```

Where `<source-id>` is:
- The Linear parent issue ID (e.g., `POL-5`) for tracker-backed workflows.
- A locally generated slug for trackerless (spec-file-backed) workflows.

---

## Schema

```json
{
  "source_id": "<Linear parent issue ID or local slug>",
  "source_type": "linear | local",
  "created_at": "<ISO timestamp>",
  "clusters": [
    {
      "cluster_id": "<cluster identifier>",
      "children": [
        {
          "id": "<child issue ID or local task ID>",
          "title": "<short title>",
          "session_type": "analyze | implement",
          "blockedBy": []
        }
      ]
    }
  ]
}
```

---

## Tracker-backed example (Linear)

```json
{
  "source_id": "POL-5",
  "source_type": "linear",
  "created_at": "2026-05-23T00:00:00.000Z",
  "clusters": [
    {
      "cluster_id": "cluster-01",
      "children": [
        {
          "id": "POL-23",
          "title": "Implement polaris loop continue",
          "session_type": "implement",
          "blockedBy": []
        },
        {
          "id": "POL-24",
          "title": "Implement polaris loop status",
          "session_type": "implement",
          "blockedBy": ["POL-23"]
        }
      ]
    }
  ]
}
```

For tracker-backed workflows, `polaris-run` may query Linear directly for child state and use `clusters.json` as supplementary ordering metadata.

---

## Trackerless example (spec-file-backed)

```json
{
  "source_id": "docs-local-instructions-layer",
  "source_type": "local",
  "created_at": "2026-05-23T00:00:00.000Z",
  "clusters": [
    {
      "cluster_id": "cluster-01",
      "children": [
        {
          "id": "task-001",
          "title": "Add instructionFile field to atlas schema",
          "session_type": "implement",
          "blockedBy": []
        },
        {
          "id": "task-002",
          "title": "Implement polaris docs seed-instructions",
          "session_type": "implement",
          "blockedBy": ["task-001"]
        }
      ]
    }
  ]
}
```

For trackerless workflows, `polaris-run` reads from `clusters.json` as the authoritative child list.

---

## Rules

- `session_type` must be `analyze` or `implement`.
- `blockedBy` entries must reference IDs within the same cluster file.
- Do not store skill traversal contracts here — those belong in `chain.md` and `chain.json`.
- `clusters.json` is written once by polaris-analyze and read by polaris-run. Do not hand-edit after a run has started.
