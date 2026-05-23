# chain.yaml — Cluster Definition Format

Each Polaris cluster requires a `chain.yaml` at `.polaris/clusters/<cluster-id>/chain.yaml` before its first session can start.

`chain.yaml` is the local source of truth for a cluster's shape: children, their session types, and dependency order. It is authored once when the cluster is planned and read by `polaris-run` and `polaris-analyze` at session start.

---

## Schema

```yaml
cluster_id: <Linear parent issue ID>       # required — e.g. POL-5
children:
  - id: <Linear child issue ID>            # required — e.g. POL-23
    title: <issue title>                   # required — short label for session reports
    session_type: analyze | implement      # required — governs which skill executes this child
    blockedBy: []                          # required — list of child IDs that must be Done first; empty list if none
```

---

## Example

```yaml
cluster_id: POL-5
children:
  - id: POL-23
    title: "Implement polaris loop continue"
    session_type: implement
    blockedBy: []
  - id: POL-24
    title: "Implement polaris loop status"
    session_type: implement
    blockedBy: [POL-23]
  - id: POL-25
    title: "Implement polaris loop resume"
    session_type: implement
    blockedBy: [POL-23]
  - id: POL-26
    title: "Implement polaris loop abort"
    session_type: implement
    blockedBy: []
  - id: POL-27
    title: "Integrate map update --changed into loop continue"
    session_type: implement
    blockedBy: [POL-23, POL-26]
```

---

## Mixed analyze + implement cluster

When a cluster has both analyze and implement children, list analyze children first. The `polaris-analyze` skill runs analyze children and halts at the boundary. `polaris-run` then executes implement children in a separate session.

```yaml
cluster_id: POL-9
children:
  - id: POL-30
    title: "Design finalize sequence"
    session_type: analyze
    blockedBy: []
  - id: POL-31
    title: "Implement finalize step 1–6"
    session_type: implement
    blockedBy: [POL-30]
  - id: POL-32
    title: "Implement finalize step 7–12"
    session_type: implement
    blockedBy: [POL-31]
```

---

## Rules

- `cluster_id` must match the Linear parent issue ID exactly.
- `blockedBy` entries must reference IDs within the same cluster.
- `session_type` must be `analyze` or `implement` — no other values.
- Do not add children that belong to a different cluster.
- Do not modify `chain.yaml` after a session has started unless correcting a typo — state is initialized from it only once.
