import { describe, expect, it } from "vitest";
import { McpBridgeAdapter } from "./mcp-bridge.js";

describe("McpBridgeAdapter", () => {
  it("fails gracefully when MCP bridge dependencies are missing", async () => {
    const adapter = new McpBridgeAdapter(async () => {
      throw new Error("Cannot find module '@tool-server/linear'");
    });

    await expect(adapter.fetchData({ trackerId: "POL-1" })).rejects.toThrow(
      "MCP bridge adapter is unavailable because '@tool-server/linear' is not installed.",
    );
  });
});
