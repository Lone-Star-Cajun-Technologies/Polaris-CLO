# Jira Tracker Adapter

## Capability Descriptor

This document describes the planned capabilities and implementation considerations for a Jira tracker adapter.

## Required Capabilities

Based on the `CapableTrackerAdapter` interface, a Jira adapter would need to support:

### Core Capabilities

- **supportsChildRelationships**: Yes - Jira has native parent-child relationships via:
  - Issue subtasks (Epic → Story, Story → Subtask)
  - Issue links (e.g., "is blocked by", "relates to")
  - Hierarchy in company-managed projects

- **supportsStatusUpdates**: Yes - Jira has rich workflow states with transitions.

- **supportsComments**: Yes - Jira has native comment support via the REST API.

- **supportsLinks**: Partial - Jira has issue links but not arbitrary URL attachments. Implementation would use:
  - Issue links for cross-referencing other Jira issues
  - Comments for external URLs
  - Custom fields for URL storage

- **supportsDependencies**: Yes - Jira has native dependency tracking via:
  - Issue link types (e.g., "is blocked by", "blocks", "relates to")
  - Dependency fields in some issue types

- **supportsLifecycleMapping**: Yes - Would map Jira workflow states to Polaris normalized lifecycle states.

- **supportsCreateChild**: Yes - Via Jira REST API to create subtasks or linked issues.

## Status Mapping Strategy

Jira status mapping is complex because status names and transition IDs vary by project and workflow configuration. Implementation would require:

### Project-Specific Configuration

```typescript
interface JiraStatusMapping {
  projectKey: string;
  workflowName?: string;
  statusMappings: Record<string, NormalizedLifecycleState>;
  transitionMappings: Record<NormalizedLifecycleState, string>; // transition IDs
}

// Example configuration
const exampleMapping: JiraStatusMapping = {
  projectKey: "POL",
  workflowName: "Software Simplified Workflow",
  statusMappings: {
    "To Do": "backlog",
    "In Progress": "in_progress",
    "In Review": "in_review",
    "Done": "done",
    "Blocked": "blocked",
  },
  transitionMappings: {
    "backlog": "transition-to-backlog-id",
    "in_progress": "start-progress-id",
    "in_review": "request-review-id",
    "done": "complete-id",
    "blocked": "block-id",
  },
};
```

### Fallback Heuristic Mapping

When explicit configuration is not available, use common Jira status patterns:

```typescript
const heuristicMappings: Record<string, NormalizedLifecycleState> = {
  // Backlog patterns
  "backlog": "backlog",
  "to do": "backlog",
  "new": "backlog",
  "open": "backlog",

  // In-progress patterns
  "in progress": "in_progress",
  "in-development": "in_progress",
  "started": "in_progress",
  "doing": "in_progress",

  // In-review patterns
  "in review": "in_review",
  "under review": "in_review",
  "ready for review": "in_review",
  "in qa": "in_review",
  "in testing": "in_review",

  // Done patterns
  "done": "done",
  "completed": "done",
  "resolved": "done",
  "closed": "done",
  "ready for deployment": "done",

  // Blocked patterns
  "blocked": "blocked",
  "on hold": "blocked",
  "waiting": "blocked",
  "paused": "blocked",

  // Cancelled patterns
  "cancelled": "cancelled",
  "canceled": "cancelled",
  "won't do": "cancelled",
  "duplicate": "cancelled",
  "invalid": "cancelled",
};
```

## Implementation Considerations

### API Requirements

- Jira REST API (v2 or v3)
- Jira Cloud vs. Jira Server/Data Center differences
- Authentication via API token, OAuth, or PAT
- Rate limiting and pagination awareness

### Issue Type Complexity

Jira has multiple issue types with different capabilities:
- **Epics**: Parent containers for stories
- **Stories/User Stories**: Standard work items
- **Tasks**: Generic work items
- **Subtasks**: Child items under stories/tasks
- **Bugs**: Defect tracking

Implementation must handle:
- Different issue type hierarchies
- Company-managed vs. team-managed projects
- Custom issue types and fields

### Workflow Transition Complexity

Jira requires explicit transition IDs (not just status names) to change state:
- Must fetch available transitions for an issue
- Transition IDs vary by workflow and project
- Some transitions require fields or conditions

### Configuration Requirements

```typescript
interface JiraAdapterConfig {
  enabled: boolean;
  baseUrl: string; // e.g., "https://your-domain.atlassian.net"
  email: string; // User email for authentication
  apiToken: string; // Jira API token
  projectKey: string; // Jira project key (e.g., "POL")
  defaultIssueType?: string; // Default issue type for new issues (e.g., "Story")
  statusMappings?: Record<string, JiraStatusMapping>;
  useHeuristicMapping?: boolean; // Fallback to pattern matching (default: true)
}
```

### Child Relationship Modeling

Jira supports multiple relationship models:

Option 1: Subtasks
- Native parent-child via issue type hierarchy
- Pros: Native Jira feature, strong typing
- Cons: Limited to specific issue types, not all projects use subtasks

Option 2: Issue Links
- Use link types like "is parent of" or "relates to"
- Pros: Flexible, works with any issue type
- Cons: Requires custom link type configuration, less structured

Option 3: Epic-Story Relationship
- Use Jira's epic field for parent-child
- Pros: Native feature, well-supported
- Cons: Limited to epic-story relationship, not arbitrary hierarchy

### Recommended Approach

Use a hybrid approach:
- Primary: Subtasks for direct parent-child (when available)
- Secondary: Issue links for cross-type relationships
- Tertiary: Epic field for epic-story relationships

## Unsupported Operations

The following operations would return explicit skip results:

- **attachLink**: Jira has issue links but not arbitrary URL attachments. Would return:
  ```typescript
  {
    attached: false,
    unsupported: true,
    reason: "Jira does not have native URL link attachments. Use addComment to include URLs or issue links for cross-referencing other Jira issues."
  }
  ```

- **transitionLifecycleState**: When workflow transition is not available, would return:
  ```typescript
  {
    applied: false,
    skipped: true,
    skipReason: "Transition to lifecycle state 'in_review' is not available in the current workflow. Configure explicit transition mappings."
  }
  ```

## Testing Strategy

- Unit tests for status mapping logic (both configured and heuristic)
- Integration tests with Jira test instance (using test project)
- Mock tests for API interactions
- Workflow transition availability tests
- Issue type hierarchy tests
- Rate limiting and pagination tests

## Non-Goals

- This adapter should NOT attempt to manage Jira projects or boards
- This adapter should NOT modify Jira workflow configurations
- This adapter should NOT manage Jira users, groups, or permissions
- This adapter should NOT interact with Jira Service Management features