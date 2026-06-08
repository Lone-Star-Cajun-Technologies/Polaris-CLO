import { request } from "node:https";
import type { LoopState } from "../loop/checkpoint.js";
import type { TrackerLifecyclePolicy } from "../config/schema.js";
import { resolveLifecycleTransition } from "../tracker/lifecycle-policy.js";

// ──────────────────────────────────────────────────────────────────────────────
// Review-gate policy
// ──────────────────────────────────────────────────────────────────────────────

/**
 * State types that finalize is PROHIBITED from transitioning to.
 * Human review is the ONLY authority for Done/Closed transitions.
 */
const DONE_STATE_TYPES = new Set(["completed", "canceled", "cancelled"]);

/**
 * Guard: throws if the given state type corresponds to Done or Closed.
 * Called before every issueUpdate — prevents any future code from silently
 * adding a Done-transition path.
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
  lifecyclePolicy?: TrackerLifecyclePolicy;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal HTTP helper
// ──────────────────────────────────────────────────────────────────────────────

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
 * Finds an "In Review" workflow state for the issue's team.
 * Matches by state type === "review" first, then by name ("In Review" / "Review").
 * Returns null if the issue has no team or no review-type state exists.
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
// ──────────────────────────────────────────────────────────────────────────────

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

/** Posts a finalize-complete comment without attempting a state transition. */
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
  if (data.commentCreate?.success !== true) {
    throw new Error(`Linear commentCreate failed: ${JSON.stringify(data.commentCreate)}`);
  }
}

/**
 * Full post-finalize Linear update (review-gate policy):
 *
 * 1. Resolves the lifecycle policy for parent-all-children-complete event.
 * 2. If policy says skip (e.g., no_status_change), skips state transition.
 * 3. Otherwise, queries the issue's team for an "In Review" workflow state.
 * 4. If found — calls issueUpdate to transition (NEVER to Done/Closed).
 * 5. If not found — skips state transition; comment body notes the missing state.
 * 6. Always posts a finalize-complete comment.
 *
 * POLICY: This function must NEVER call issueUpdate with a Done or Closed
 * state ID. The assertNotDoneState guard enforces this at runtime.
 */
export async function updateLinearIssueAfterFinalize(options: PostCommentOptions): Promise<void> {
  const { issueId, state, branch, prUrl, validationPassed, apiKey, lifecyclePolicy } = options;

  // Resolve lifecycle transition from policy
  const lifecycleTransition = resolveLifecycleTransition("parent-all-children-complete", lifecyclePolicy);

  // If policy says skip, skip the state transition entirely
  if (lifecycleTransition.skip) {
    console.log(`[Linear] Skipping lifecycle transition for ${issueId}: ${lifecycleTransition.skipReason}`);

    const body = buildCommentBody({
      state,
      branch,
      prUrl,
      validationPassed,
      reviewStateMissing: false,
    });

    const commentData = await linearGraphQL<{ commentCreate?: { success?: boolean } }>(
      `mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId, body },
      apiKey,
    );
    if (commentData.commentCreate?.success !== true) {
      throw new Error(`Linear commentCreate failed: ${JSON.stringify(commentData.commentCreate)}`);
    }
    return;
  }

  // Only attempt state transition when the policy maps to the "in_review" normalized state.
  // Other normalized states (e.g. "done", "no_status_change") are not handled by this function.
  const targetState = lifecycleTransition.targetState;

  if (targetState !== "in_review") {
    console.log(`[Linear] Skipping lifecycle transition for ${issueId}: target state "${targetState}" is not handled by Linear finalize`);

    const body = buildCommentBody({
      state,
      branch,
      prUrl,
      validationPassed,
      reviewStateMissing: false,
    });

    const commentData = await linearGraphQL<{ commentCreate?: { success?: boolean } }>(
      `mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId, body },
      apiKey,
    );
    if (commentData.commentCreate?.success !== true) {
      throw new Error(`Linear commentCreate failed: ${JSON.stringify(commentData.commentCreate)}`);
    }
    return;
  }

  let reviewState: WorkflowState | null = null;
  try {
    reviewState = await findReviewState(issueId, apiKey);
  } catch (err) {
    // Log the error so auth/network/GraphQL failures are visible, then fall back to comment-only
    console.error(`[Linear] findReviewState failed for issue ${issueId}: ${err instanceof Error ? err.message : String(err)}`);
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
    if (updateData.issueUpdate?.success !== true) {
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
  if (commentData.commentCreate?.success !== true) {
    throw new Error(`Linear commentCreate failed: ${JSON.stringify(commentData.commentCreate)}`);
  }
}
