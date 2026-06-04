import type { LoopState } from "../../loop/checkpoint.js";
import { updateLinearIssueAfterFinalize } from "../linear.js";

function isLikelyLinearIssueId(value: string): boolean {
  const trimmed = value.trim();
  const linearIssueKey = /^[A-Z][A-Z0-9]*-\d+$/;
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return linearIssueKey.test(trimmed) || uuidLike.test(trimmed);
}

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
  if (!isLikelyLinearIssueId(issueId)) {
    process.stderr.write(
      `Warning: issue identifier "${issueId}" is not a valid Linear issue ID/key — skipping Linear update.\n`,
    );
    return;
  }
  console.log(`[11/12] Using Linear issue ID/key: ${issueId}`);

  await updateLinearIssueAfterFinalize({ issueId, state, branch, prUrl, validationPassed, apiKey });
  console.log(`Linear parent ${issueId} updated.`);
}
