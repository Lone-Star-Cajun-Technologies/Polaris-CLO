import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { handlePolarisLoopStatus, handlePolarisStatus } from "./status.js";
import { handlePolarisCurrentState } from "./current-state.js";
import { handleLoopContinueDryRun } from "./loop-dry-run.js";
import { handleLoopContinueConfirmed } from "./loop-continue.js";
import { handlePolarisClaimChild } from "./claim-child.js";
import { handlePolarisDispatchResult } from "./dispatch-result.js";
import { LINEAR_TOOLS, handleLinearListIssues, handleLinearSaveIssue } from "./linear.js";

export const TOOLS: Tool[] = [
  ...LINEAR_TOOLS, // Add Linear tools here
  {
    name: "polaris_status",
    description:
      "Return the current Polaris loop run state. Calls `polaris status --json` and returns compact structured output.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "polaris_loop_status",
    description:
      "Return the current Polaris loop status, scoped to the loop subsystem. Calls `polaris loop status --json`.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "polaris_current_state",
    description:
      "Return the raw parsed current-state.json for a Polaris artifact directory, with sensitive keys redacted.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_dir: {
          type: "string",
          description: "Artifact directory name under .taskchain_artifacts/. Default: polaris-run",
        },
      },
      required: [],
    },
  },
  {
    name: "polaris_loop_continue_dry_run",
    description:
      "Preview what loop continue would do — returns eligibility status and approval template without mutating any state. Dry-run only: no bootstrap packets, no worker dispatch, no execution leases.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_dir: {
          type: "string",
          description: "Artifact directory name under .taskchain_artifacts/. Default: polaris-run",
        },
        expected_step_cursor: {
          type: "string",
          description: "Expected current step cursor (e.g. '06-decide-continuation')",
        },
      },
      required: ["expected_step_cursor"],
    },
  },
  {
    name: "polaris_loop_continue_confirmed",
    description:
      "Submit a pre-approved continuation envelope to gate a loop continue action. Requires a valid ContinuationApprovalEnvelope from a prior dry-run call. Does not dispatch workers — returns approval status only.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_dir: {
          type: "string",
          description: "Artifact directory name under .taskchain_artifacts/. Default: polaris-run",
        },
        run_id: {
          type: "string",
          description: "Run ID from the approval envelope",
        },
        expected_step_cursor: {
          type: "string",
          description: "Expected step cursor from the approval envelope",
        },
        fingerprint: {
          type: "string",
          description: "State fingerprint from the approval envelope",
        },
        runtime_generation: {
          type: "number",
          description: "Runtime generation counter from the approval envelope",
        },
        issued_at: {
          type: "string",
          description: "ISO 8601 timestamp when the envelope was issued",
        },
        expires_at: {
          type: "string",
          description: "ISO 8601 timestamp when the envelope expires",
        },
        nonce: {
          type: "string",
          description: "Unique nonce from the approval envelope",
        },
        requested_action: {
          type: "string",
          description: 'Must be "loop_continue"',
        },
      },
      required: [
        "run_id",
        "expected_step_cursor",
        "fingerprint",
        "runtime_generation",
        "issued_at",
        "expires_at",
        "nonce",
        "requested_action",
      ],
    },
  },
  {
    name: "polaris_claim_child",
    description:
      "Atomically claim an open Polaris child issue by writing active_child in current-state.json. Mutates run state and appends telemetry.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_dir: {
          type: "string",
          description: "Artifact directory name under .taskchain_artifacts/. Default: polaris-run",
        },
        child_id: {
          type: "string",
          description: "Open child issue ID to claim, e.g. POL-111",
        },
      },
      required: ["child_id"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "polaris_dispatch_result",
    description:
      "Record a Polaris worker result for the matching active_child in current-state.json and append dispatch-result telemetry.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_dir: {
          type: "string",
          description: "Artifact directory name under .taskchain_artifacts/. Default: polaris-run",
        },
        child_id: {
          type: "string",
          description: "Active child issue ID whose result is being recorded",
        },
        status: {
          type: "string",
          description: "Worker status, such as completed, failed, or blocked",
        },
        commit: {
          type: "string",
          description: "Commit hash produced by the worker, when available",
        },
        validation: {
          description: "Validation summary or structured validation evidence from the worker",
        },
      },
      required: ["child_id", "status"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

const REGISTERED = new Set(TOOLS.map((t) => t.name));

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!REGISTERED.has(name)) {
    const result = {
      ok: false,
      error: "unknown_tool",
      message: `Unknown tool: ${name}`,
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  let result: Record<string, unknown>;
  switch (name) {
    case "polaris_status":
      result = await handlePolarisStatus();
      break;
    case "polaris_loop_status":
      result = await handlePolarisLoopStatus();
      break;
    case "polaris_current_state":
      result = await handlePolarisCurrentState(args as { artifact_dir?: string });
      break;
    case "polaris_loop_continue_dry_run":
      result = await handleLoopContinueDryRun(args);
      break;
    case "polaris_loop_continue_confirmed":
      result = await handleLoopContinueConfirmed(args);
      break;
    case "polaris_claim_child":
      result = await handlePolarisClaimChild(args);
      break;
    case "polaris_dispatch_result":
      result = await handlePolarisDispatchResult(args);
      break;
    case "linear_list_issues":
      result = await handleLinearListIssues(args);
      break;
    case "linear_save_issue":
      result = await handleLinearSaveIssue(args);
      break;
    default:
      result = { ok: false, error: "unknown_tool", message: `Unhandled tool: ${name}` };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
