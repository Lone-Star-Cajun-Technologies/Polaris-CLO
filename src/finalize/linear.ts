import { request } from "node:https";
import type { LoopState } from "../loop/checkpoint.js";

// ──────────────────────────────────────────────────────────────────────────────
// Review-gate policy
// ──────────────────────────────────────────────────────────────────────────────

/**
 * State types that finalize is PROHIBITED from transitioning to.
 * Human review is the ONLY authority for Done/Closed transitions.
 */
const DONE_STATE_TYPES = new Set(["completed", "cancelled"]);

/**
 * Prevent transitioning an issue to a Done/Closed workflow state.
 *
 * Throws an Error if `stateType`, compared case-insensitively, is one of the disallowed Done/Closed types.
 *
 * @param stateType - The workflow state's machine/type identifier (case-insensitive check)
 * @param stateName - The workflow state's human-readable name (used in the thrown error message)
 * @throws Error when `stateType` corresponds to a Done/Closed state
 */
export function assertNotDoneState(stateType: string, stateName: string): void {
  if (DONE_STATE_TYPES.has(stateType.toLowerCase())) {
    throw new Error(
      `[Linear review-gate] Finalize is prohibited from transitioning issues to Done or Closed states. ` +
        `Attempted: "${stateName}" (type: "${stateType}"). ` +
        `Only human review may mark issues as Done/Closed.`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface PostCommentOptions {
  issueId: string;
  state: LoopState;
  branch: string;
  prUrl: string;
  validationPassed: boolean;
  apiKey: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal HTTP helper
/**
 * Send a GraphQL POST to the Linear API and return the parsed `data` payload.
 *
 * @param query - The GraphQL query or mutation string
 * @param variables - Variables to include with the GraphQL request
 * @param apiKey - Linear API key used as the `Authorization` header
 * @returns The `data` field from the Linear GraphQL response parsed to type `T`
 * @throws Error if the HTTP status is >= 400, the GraphQL response contains `errors`, the response body cannot be parsed as JSON, or the request/network fails
 */

async function linearGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  apiKey: string,
): Promise<T> {
  const payload = JSON.stringify({ query, variables });
  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        hostname: "api.linear.app",
        path: "/graphql",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Linear API returned ${res.statusCode}`));
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            const parsed = JSON.parse(text) as { errors?: unknown[]; data?: T };
            if (parsed.errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
              reject(new Error(`Linear API GraphQL errors: ${JSON.stringify(parsed.errors)}`));
            } else {
              resolve(parsed.data as T);
            }
          } catch (err) {
            reject(
              new Error(
                `Failed to parse Linear API response: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Review-state discovery
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Locate the team's "In Review" workflow state for a given issue.
 *
 * Matches workflow states by `type === "review"` (case-insensitive) first; if none match,
 * falls back to states whose `name` equals "In Review" or "Review" (case-insensitive).
 *
 * @returns The matching `WorkflowState` if found; `null` if the issue has no team or no matching review state exists.
 */
export async function findReviewState(
  issueId: string,
  apiKey: string,
): Promise<WorkflowState | null> {
  const issueData = await linearGraphQL<{ issue?: { team?: { id: string } } }>(
    `query GetIssueTeam($id: String!) { issue(id: $id) { team { id } } }`,
    { id: issueId },
    apiKey,
  );
  const teamId = issueData.issue?.team?.id;
  if (!teamId) return null;

  const statesData = await linearGraphQL<{ workflowStates?: { nodes: WorkflowState[] } }>(
    `query GetWorkflowStates($teamId: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }`,
    { teamId },
    apiKey,
  );
  const states = statesData.workflowStates?.nodes ?? [];

  return (
    states.find((s) => s.type.toLowerCase() === "review") ??
    states.find((s) => /^in\s+review$/i.test(s.name) || /^review$/i.test(s.name)) ??
    null
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Comment body builder
/**
 * Build the Markdown comment body posted to a Linear issue after finalize completes.
 *
 * The returned body contains a small table with the run identifier, branch, PR URL,
 * number of completed child runs, and a map validation result; when `reviewStateMissing`
 * is true, a warning about the missing "In Review" workflow state is appended.
 *
 * @param state - The Loop state object; its `run_id` and `completed_children.length` are included in the comment
 * @param branch - The git branch name associated with the run
 * @param prUrl - The pull request URL to display in the comment
 * @param validationPassed - Whether map validation succeeded; renders as "✓ passed" or "✗ failed"
 * @param reviewStateMissing - If true, appends a warning that an "In Review" workflow state was not found
 * @returns The assembled Markdown comment as a single string
 */

function buildCommentBody(opts: {
  state: LoopState;
  branch: string;
  prUrl: string;
  validationPassed: boolean;
  reviewStateMissing: boolean;
}): string {
  const lines = [
    `**polaris finalize complete** — run \`${opts.state.run_id}\``,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Branch | \`${opts.branch}\` |`,
    `| PR | ${opts.prUrl} |`,
    `| Children completed | ${opts.state.completed_children.length} |`,
    `| Map validation | ${opts.validationPassed ? "✓ passed" : "✗ failed"} |`,
  ];
  if (opts.reviewStateMissing) {
    lines.push(
      ``,
      `> ⚠️ No "In Review" workflow state found for this issue's team — issue state was not updated automatically. Transition manually if needed.`,
    );
  }
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Post a finalize-complete comment on a Linear issue without changing the issue's workflow state.
 *
 * @param options - Object containing `issueId`, `state`, `branch`, `prUrl`, `validationPassed`, and `apiKey`
 * @throws Error if the Linear `commentCreate` mutation returns `success === false`
 */
export async function postLinearComment(options: PostCommentOptions): Promise<void> {
  const { issueId, state, branch, prUrl, validationPassed, apiKey } = options;
  const body = buildCommentBody({ state, branch, prUrl, validationPassed, reviewStateMissing: false });

  const data = await linearGraphQL<{ commentCreate?: { success?: boolean } }>(
    `mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body },
    apiKey,
  );
  if (data.commentCreate?.success === false) {
    throw new Error(`Linear commentCreate failed: ${JSON.stringify(data.commentCreate)}`);
  }
}

/**
 * Finalize a Linear issue by optionally moving it to an "In Review" workflow state and posting a finalize-complete comment.
 *
 * Discovers an appropriate "In Review" workflow state for the issue; if found, transitions the issue to that state (will not transition to Done/Closed). Always posts a comment summarizing the finalize run; the comment indicates when an "In Review" state was not found.
 *
 * @param options - Options containing `issueId`, finalize `state`, `branch`, `prUrl`, `validationPassed`, and `apiKey`
 * @throws Error if a discovered `issueUpdate` or `commentCreate` mutation returns `success === false`
 * @throws Error if the discovered workflow state is of a prohibited Done/Closed type (enforced by `assertNotDoneState`)
 */
export async function updateLinearIssueAfterFinalize(options: PostCommentOptions): Promise<void> {
  const { issueId, state, branch, prUrl, validationPassed, apiKey } = options;

  let reviewState: WorkflowState | null = null;
  try {
    reviewState = await findReviewState(issueId, apiKey);
  } catch {
    // State query failed — fall back to comment-only; do not propagate.
  }

  if (reviewState !== null) {
    // Enforce review-gate: must never transition to Done or Closed.
    assertNotDoneState(reviewState.type, reviewState.name);

    const updateData = await linearGraphQL<{ issueUpdate?: { success?: boolean } }>(
      `mutation UpdateIssueState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId: reviewState.id },
      apiKey,
    );
    if (updateData.issueUpdate?.success === false) {
      throw new Error(`Linear issueUpdate failed: ${JSON.stringify(updateData.issueUpdate)}`);
    }
  }

  const body = buildCommentBody({
    state,
    branch,
    prUrl,
    validationPassed,
    reviewStateMissing: reviewState === null,
  });

  const commentData = await linearGraphQL<{ commentCreate?: { success?: boolean } }>(
    `mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body },
    apiKey,
  );
  if (commentData.commentCreate?.success === false) {
    throw new Error(`Linear commentCreate failed: ${JSON.stringify(commentData.commentCreate)}`);
  }
}
