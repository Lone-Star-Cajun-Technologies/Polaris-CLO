# GitHub Issues Tracker Adapter

## Capability Descriptor

This document describes the planned capabilities and implementation considerations for a GitHub Issues tracker adapter.

## Required Capabilities

Based on the `CapableTrackerAdapter` interface, a GitHub Issues adapter would need to support:

### Core Capabilities

- **supportsChildRelationships**: Partial - GitHub Issues does not have native parent-child relationships. Implementation would need to use:
  - Issue tasklists (checklists within an issue)
  - Labels with hierarchical naming conventions (e.g., `parent:POL-123`, `child:POL-124`)
  - References in issue body/description
  - GitHub Projects (project boards) for grouping

- **supportsStatusUpdates**: Yes - GitHub Issues has a `state` field (`open`, `closed`) and labels can represent custom states.

- **supportsComments**: Yes - GitHub Issues has native comment support via the Issue Comments API.

- **supportsLinks**: Partial - GitHub Issues does not have native link attachments. Implementation would use:
  - Comments containing URLs
  - Markdown links in issue body/description
  - Issue references (e.g., `#123`) for cross-linking

- **supportsDependencies**: Partial - GitHub Issues has task dependencies in tasklists. Broader dependency tracking would require:
  - Tasklist item dependencies
  - Labels for dependency tracking
  - Custom issue relations via GitHub Projects

- **supportsLifecycleMapping**: Yes - Would map GitHub issue states/labels to Polaris normalized lifecycle states.

- **supportsCreateChild**: Yes - Via GitHub Issues API to create new issues with appropriate labels/references.

## Status Mapping Strategy

GitHub Issues has a simple native state model (`open`, `closed`). Lifecycle state mapping would rely primarily on labels:

```typescript
// Proposed label-to-lifecycle mapping
const labelMappings: Record<string, NormalizedLifecycleState> = {
  "status:backlog": "backlog",
  "status:in-progress": "in_progress",
  "status:in-review": "in_review",
  "status:done": "done",
  "status:blocked": "blocked",
  "status:cancelled": "cancelled",
};

// Native state mapping
const stateMappings: Record<string, NormalizedLifecycleState> = {
  "open": "in_progress", // Default for open issues
  "closed": "done", // Default for closed issues
};
```

## Implementation Considerations

### API Requirements

- GitHub REST API or GraphQL API
- Authentication via personal access token or GitHub App
- Rate limiting awareness (GitHub has strict rate limits)

### Child Relationship Modeling

Option 1: Tasklist-based
- Use issue tasklists for child items
- Pros: Native GitHub feature
- Cons: Limited to single-level, task items are not full issues

Option 2: Label-based
- Use labels like `parent:POL-123` and `child:POL-124`
- Pros: Flexible, works with existing issues
- Cons: Requires label management, not native parenting

Option 3: Body/Description references
- Parse issue body for child references
- Pros: Human-readable
- Cons: Brittle parsing, no API-level querying

Option 4: GitHub Projects
- Use project boards to group related issues
- Pros: Native GitHub feature, supports hierarchy
- Cons: Requires project setup, adds complexity

### Recommended Approach

Use a hybrid approach:
- Primary: Label-based parent/child relationships for flexibility
- Secondary: Tasklists for simple checklists within an issue
- Optional: GitHub Projects for project-level organization

### Configuration Requirements

```typescript
interface GitHubAdapterConfig {
  enabled: boolean;
  owner: string; // Repository owner (e.g., "lsctech")
  repo: string; // Repository name (e.g., "polaris")
  token?: string; // GitHub personal access token
  childRelationshipMode?: "labels" | "tasklists" | "projects" | "hybrid";
  labelPrefix?: string; // Default: "status:" for lifecycle labels
  parentLabelPrefix?: string; // Default: "parent:"
  childLabelPrefix?: string; // Default: "child:"
}
```

## Unsupported Operations

The following operations would return explicit skip results:

- **attachLink**: GitHub does not have native link attachments. Would return:
  ```typescript
  {
    attached: false,
    unsupported: true,
    reason: "GitHub Issues does not have native link attachments. Use addComment to include URLs."
  }
  ```

## Testing Strategy

- Unit tests for status mapping logic
- Integration tests with GitHub test repository (using test token)
- Mock tests for API interactions
- Rate limiting behavior tests
- Label management tests

## Non-Goals

- This adapter should NOT attempt to manage pull requests (those are a separate concern)
- This adapter should NOT modify repository settings or permissions
- This adapter should NOT manage GitHub Actions or workflows