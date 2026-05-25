import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { handlePolarisLoopStatus, handlePolarisStatus } from "./status.js";
import { handlePolarisCurrentState } from "./current-state.js";
import { handleLoopContinueDryRun } from "./loop-dry-run.js";

export const TOOLS: Tool[] = [
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
          description: "Artifact directory name under .taskchain_artifacts/. Default: bootstrap-run",
        },
        expected_step_cursor: {
          type: "string",
          description: "Expected current step cursor (e.g. '06-decide-continuation')",
        },
      },
      required: ["expected_step_cursor"],
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
    default:
      result = { ok: false, error: "unknown_tool", message: `Unhandled tool: ${name}` };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
