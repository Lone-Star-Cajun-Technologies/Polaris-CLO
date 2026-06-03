---
name: closeout-librarian-step-01
description: Read packet, load cluster evidence, and build the work inventory for this reconciliation session.
---

# Step 01 — Load Cluster Context

## Purpose

Build a complete picture of what the cluster accomplished. This is the foundation for all
subsequent reconciliation steps. Nothing is written in this step.

## Actions

### 1.1 Read and Validate Packet

Read the packet from the path provided in the dispatch prompt.

Validate required fields:
- `role` must be `"closeout-librarian"`
- `run_id`, `dispatch_id`, `cluster_id` must be present and non-empty
- `completed_children` must be a non-empty array
- `result_path` must be present
- `allowed_write_paths` must be present

If validation fails: write a minimal failure result to `result_path` and terminate.

### 1.2 Load Child Summaries

For each entry in `packet.child_summaries`:
1. Read the compact-return result at `child_summary.compact_return_path` (if present)
2. Read the cognition note at `child_summary.cognition_note_path` (if present)
3. Note `child_summary.changed_files` — the primary file inventory for this cluster

Build a combined `all_changed_files` list (deduplicated) across all children.

### 1.3 Load Folder Cognition Context

For each entry in `packet.polaris_md_paths`:
1. Read `polaris_md` (current POLARIS.md for this folder)
2. Read `summary_md` (current SUMMARY.md, if path provided and file exists)
3. Read `cognition_index` (archive index, if path provided and file exists)

Note which folders have pending cognition notes (from `packet.cognition_notes`).

### 1.4 Build Work Inventory

Produce an internal inventory (not written to disk):

```yaml
work_inventory:
  cluster_id: <from packet>
  completed_children: [<ids>]
  all_changed_files: [<deduplicated list>]
  affected_folders: [<from packet.affected_folders>]
  pending_cognition_notes: [<paths>]
  docs_candidate_for_ingestion: [<from packet.smartdocs_raw_paths>]
  polaris_md_files: { <folder>: <current content> }
  summary_md_files: { <folder>: <current content or null> }
```

### 1.5 Load Run Report

Read the run report at `packet.run_report_path` (if present). This provides a structured
summary of what work was done.

### 1.6 Emit Telemetry

Emit `librarian-start` event (if telemetry path provided).

## Completion Criteria

- Packet validated
- All available child summaries loaded
- All available folder cognition loaded
- Work inventory built

Proceed to step 02.
