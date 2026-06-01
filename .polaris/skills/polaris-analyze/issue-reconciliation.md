---
name: polaris-issue-reconciliation
description: Workflow for reconciling existing Linear issues into the canonical Polaris format. Use when existing implementation issues are missing required sections or use non-canonical section names.
---

# Polaris Issue Reconciliation Workflow

Use this workflow to bring existing Linear implementation issues into the canonical 8-section format
defined in `issue-template.md`. This is not a `polaris-analyze` run — it is a manual or
scripted reconciliation pass.

## When to use

- An existing IMPLEMENT parent or child issue is blocking a `polaris-run` execution.
- `polaris-run` reported `preflight-scope-missing` or `preflight-body-missing`.
- An issue uses non-canonical headers ("Implementation scope", "Expected code areas", etc.).
- An issue has no body at all (title-only stub).
- You want to prepare a set of existing issues before starting a new `polaris-run`.

---

## Reconciliation rules

### Preserve original meaning

Do not change what an issue is asking for. Only restructure the body into the canonical format.
If you are uncertain whether a passage belongs under one header vs. another, preserve it verbatim
and note the ambiguity in a comment.

### Scope

- If scope is explicitly stated anywhere in the body (paths, globs, named files, module names),
  move that content into `## Scope` as a bullet list.
- If scope can be clearly inferred from the objective or goal, write the inferred paths and
  note that they were inferred: `- src/loop/** (inferred from objective)`.
- If scope is genuinely not determinable from the existing body, write:
  ```
  ## Scope
  - TBD — BLOCKED: scope missing
  ```
  Then mark the issue as **Blocked** in Linear. Do not guess or invent paths.

### Acceptance Criteria and Validation

- If acceptance criteria exist under any heading, move them to `## Acceptance Criteria`.
- If validation commands exist (e.g. `npm test`, CI commands), move them to `## Validation`.
- If no validation commands exist, write the standard minimum:
  ```
  ## Validation
  - npm run build
  - npm test
  ```

### Links

- Preserve all links to related issues, PRs, and clusters.
- Move them to `## Context` if they explain why the issue exists.
- Move them to `## Ordering` if they express a dependency.

### Non-goals / Out of scope

- If the original issue has "Out of scope" or "Non-goals" content, move it to `## Non-goals`.

### Do not mark ready if TBD/BLOCKED remains

If any section still contains `TBD — BLOCKED` after reconciliation, do not change the issue
status to Ready or In Progress. The issue must remain Blocked until scope (or other TBD content)
is resolved by a human.

---

## Step-by-step reconciliation prompt

Use this prompt with a capable AI assistant to reconcile a single issue.
Replace `<ISSUE_BODY>` and `<ISSUE_TITLE>` with the actual content.

```
You are reconciling a Polaris Linear issue into the canonical 8-section format.

Issue title: <ISSUE_TITLE>
Current body:
---
<ISSUE_BODY>
---

Produce a rewritten body using exactly these sections in this order:
  ## Objective
  ## Context
  ## Goal
  ## Scope
  ## Acceptance Criteria
  ## Validation
  ## Ordering
  ## Non-goals

Rules:
1. Preserve original meaning. Do not change what the issue asks for.
2. Do not invent scope. If scope is stated or clearly inferable, use it.
   If not, write:
     ## Scope
     - TBD — BLOCKED: scope missing
3. Preserve all links to related issues, PRs, or clusters.
4. If acceptance criteria exist anywhere, move them under ## Acceptance Criteria.
5. If validation commands exist, move them under ## Validation.
   If none exist, add:
     ## Validation
     - npm run build
     - npm test
6. Do not mark the issue ready if any section still says TBD — BLOCKED.
7. Output only the rewritten body (no commentary).
```

---

## Batch reconciliation guidance

For a set of issues before a `polaris-run`:

1. **Identify affected issues**: Run `polaris-run` in dry-run mode or check `clusters.json`
   for child issue IDs with missing/empty bodies.

2. **Fetch current bodies**: For each issue ID, use the Linear MCP tool or CLI to fetch
   the current title and body.

3. **Reconcile one at a time**: Apply the reconciliation prompt above to each issue.
   Review the output before updating Linear.

4. **Update Linear**: Use the Linear MCP `save_issue` tool to update the body of each issue.
   Do not change issue status unless explicitly reconciling a TBD-BLOCKED scope.

5. **Mark TBD-BLOCKED issues as Blocked**: For any issue where scope is TBD, update the
   Linear status to Blocked and add a comment explaining what is needed to unblock.

6. **Re-run preflight**: After reconciling, re-run `polaris-run` (or the preflight check)
   to confirm all issues are now packet-actionable.

---

## Verification after reconciliation

After updating issue bodies, verify the reconciled issues are packet-actionable:

```bash
# Dry-run a polaris-run to check all preflight gates pass
npm run polaris -- loop dispatch --dry-run <cluster-id>
```

All children should pass body and scope preflight gates. If any fail,
the output will identify which issue and which section is still missing.
