---
name: polaris-medic-step-05
description: Create a medical chart documenting the failure and treatment.
---

# Step 05 — Create Chart

## Purpose

Create a medical chart in `smartdocs/medic/charts/` documenting the failure event, diagnosis, treatment, and validation outcome. This chart becomes part of the repository's medical history.

## Actions

### 5.1 Generate Chart ID

Use the chart ID generator from the Chart system (POL-327):
- Import `generateNextChartId` from `src/medic/chart-id.ts`
- Generate the next chart ID for today
- Charts directory: `smartdocs/medic/charts/`

### 5.2 Prepare Chart Front-Matter

Prepare the YAML front-matter for the chart:

```yaml
---
chart_id: <generated chart ID>
cluster_id: <from packet>
route: <from cluster context>
status: <open | resolved | deferred>
related_charts: []
created: <ISO8601 timestamp>
updated: <ISO8601 timestamp>
drift_observations: []
---
```

Set status based on validation outcome:
- `resolved` if validation succeeded
- `deferred` if validation failed or repair was incomplete
- `open` if diagnosis was uncertain

### 5.3 Prepare Chart Sections

Write the required chart sections:

- **Problem**: Description of the original failure
- **Symptoms**: Error messages, validation failures, observable behavior
- **Root Cause**: Identified root cause from step 02
- **Affected Files**: List of files involved in the failure and repair
- **Treatment**: Description of repair changes made in step 03
- **Validation**: Validation outcome from step 04
- **Prevention**: Recommendations to prevent similar failures
- **When To Read This Chart**: Conditions under which this chart is relevant

### 5.4 Write Chart File

Write the chart to `smartdocs/medic/charts/<chart_id>.md`

Verify the chart passes schema validation using the Chart system (POL-327):
- Front-matter must match `ChartFrontMatter` schema
- All required sections must be present

### 5.5 Record Chart Creation

Record the chart creation internally (not written to disk):

```yaml
chart_created:
  chart_id: <generated chart ID>
  file_path: <path to chart file>
  validation_passed: <true | false>
```

### 5.6 Emit Telemetry

Emit `medic-step-complete` event for step 05 (if telemetry path provided).

## Completion Criteria

- Chart ID generated
- Chart file created with valid front-matter and sections
- Chart passes schema validation

Proceed to step 06.