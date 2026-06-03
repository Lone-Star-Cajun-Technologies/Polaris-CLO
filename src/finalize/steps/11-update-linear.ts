import type { LoopState } from "../../loop/checkpoint.js";
import { updateLinearIssueAfterFinalize } from "../linear.js";

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
