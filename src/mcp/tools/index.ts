import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { handlePolarisLoopStatus, handlePolarisStatus } from "./status.js";
import { handlePolarisCurrentState } from "./current-state.js";

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
    default:
      result = { ok: false, error: "unknown_tool", message: `Unhandled tool: ${name}` };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
