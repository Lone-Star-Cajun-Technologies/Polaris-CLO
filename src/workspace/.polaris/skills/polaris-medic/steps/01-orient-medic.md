---
name: polaris-medic-step-01
description: Read packet, load failed result, and build the diagnosis inventory for this session.
---

# Step 01 — Orient Medic

## Purpose

Build a complete picture of the failure event. This is the foundation for all subsequent diagnosis and repair steps. Nothing is written in this step.

## Actions

### 1.1 Read and Validate Packet

Read the packet from the path provided in the dispatch prompt.

Validate required fields:
- `role` must be `"medic"`
- `run_id`, `dispatch_id`, `cluster_id` must be present and non-empty
- `failed_result_packet` must be present
- `result_path` must be present
- `allowed_write_paths` must be present

If validation fails: write a minimal failure result to `result_path` and terminate.

### 1.2 Load Failed Result Packet

Read the failed result packet from `packet.failed_result_packet`.

Extract:
- Child ID that failed
- Error message
- Files that were changed (if any)
- Validation failures (if any)
- Execution context (if any)

### 1.3 Load Cluster Context

Load cluster context from `packet.cluster_context`.

Extract:
- Cluster ID
- Branch name
- Related work items
- Route information (if available)

### 1.4 Build Diagnosis Inventory

Produce an internal inventory (not written to disk):

```yaml
diagnosis_inventory:
  cluster_id: <from packet>
  failed_child_id: <from failed_result_packet>
  error_message: <from failed_result_packet>
  changed_files: <from failed_result_packet>
  validation_failures: <from failed_result_packet>
  execution_context: <from failed_result_packet>
  route: <from cluster_context>
  branch: <from cluster_context>
```

### 1.5 Emit Telemetry

Emit `medic-start` event (if telemetry path provided).

## Completion Criteria

- Packet validated
- Failed result packet loaded
- Cluster context loaded
- Diagnosis inventory built

Proceed to step 02.