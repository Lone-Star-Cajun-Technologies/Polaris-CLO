import type { LoopState } from "../../loop/checkpoint.js";
import { updateLinearIssueAfterFinalize } from "../linear.js";

/**
 * Update the Linear parent issue to reflect the finalize step outcome.
 *
 * If the Linear integration is disabled, the `LINEAR_API_KEY` environment variable is missing, or no parent issue ID is available, the function logs a warning and returns without making an update. Errors from the update operation propagate to the caller.
 *
 * @param state - Current loop state containing cluster and run context
 * @param branch - Git branch name associated with the finalize step
 * @param prUrl - URL of the related pull request, if any
 * @param validationPassed - Whether post-finalize validation succeeded
 * @param linearEnabled - Flag that enables or disables the Linear integration
 * @param parentIssueId - Optional explicit Linear parent issue ID; if omitted, `state.cluster_id` is used
 */
export async function stepUpdateLinear(
  state: LoopState,
  branch: string,
  prUrl: string,
  validationPassed: boolean,
  linearEnabled: boolean,
  parentIssueId?: string,
): Promise<void> {
  if (!linearEnabled) {
    console.log("[11/12] Linear integration disabled — skipping.");
    return;
  }

  const apiKey = process.env["LINEAR_API_KEY"];
  if (!apiKey) {
    process.stderr.write("Warning: LINEAR_API_KEY not set — skipping Linear update.\n");
    return;
  }

  const issueId = parentIssueId ?? state.cluster_id;
  if (!issueId) {
    process.stderr.write("Warning: no Linear parent issue ID — skipping Linear update.\n");
    return;
  }

  await updateLinearIssueAfterFinalize({ issueId, state, branch, prUrl, validationPassed, apiKey });
  console.log(`Linear parent ${issueId} updated.`);
}
