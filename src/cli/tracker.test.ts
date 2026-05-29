import { describe, it, expect, vi } from "vitest";
import { createTrackerCommand } from "./tracker.js";

describe("tracker CLI", () => {
  it("sync-in without trackerId exits with a clear usage error", async () => {
    const command = createTrackerCommand({ repoRoot: "/repo" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    try {
      await expect(
        command.parseAsync(["node", "tracker", "sync-in"], { from: "node" }),
      ).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        "Error: trackerId is required (e.g., 'polaris tracker sync-in POL-198').",
      );
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
