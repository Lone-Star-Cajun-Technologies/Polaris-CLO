import { describe, expect, it, vi } from "vitest";

describe("CLI startup", () => {
  it("config show does not import @tool-server/linear", async () => {
    vi.resetModules();
    const importedToolServer = vi.fn();

    vi.doMock("@tool-server/linear", () => {
      importedToolServer();
      throw new Error("unexpected @tool-server/linear import");
    });

    const { createPolarisCommand } = await import("./index.js");
    const runConfigShow = vi.fn();
    const program = createPolarisCommand({
      repoRoot: "/repo",
      runConfigShow,
    });

    await expect(
      program.parseAsync(["node", "polaris", "config", "show"], { from: "node" }),
    ).resolves.toBeDefined();

    expect(runConfigShow).toHaveBeenCalledWith({ repoRoot: "/repo" });
    expect(importedToolServer).not.toHaveBeenCalled();

    vi.doUnmock("@tool-server/linear");
  });
});
