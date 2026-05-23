# linear-cluster-planning linkage

Source: Linear MCP tools (`mcp__linear__save_issue`, `mcp__linear__save_project`, etc.)

---

## Allowed phases

- 08 — output-package (only when explicitly instructed by the user)

---

## Purpose

Create Linear issues from the finalized cluster proposals. Used only when the user explicitly instructs evo-plan to create issues, not as part of default planning output.

---

## Allowed scope

- Create parent cluster issues
- Create child issues in dependency order
- Create sub-child issues after their parents
- Preserve execution ordering in issue numbering

---

## Forbidden scope

- Do not create Linear issues during Phases 01–07
- Do not create issues before cluster proposals are finalized and reviewed
- Do not create issues speculatively or as drafts during planning
- Do not create issues if the user has not explicitly requested issue creation

---

## Creation order rules

```text
1. Create blockers before blocked work
2. Create parent clusters before children
3. Create children before sub-children
4. Issue creation order must match intended execution order
5. Preserve dependency ordering
6. Avoid forward dependencies
```

---

## Invocation note

Only invoke this linked skill if the user has explicitly said to create Linear issues. Default planning output is analysis only — this skill is opt-in.
