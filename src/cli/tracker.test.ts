import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrackerCommand } from "./tracker.js";
import { LocalGraph } from "../tracker/local-graph.js";
import * as linearModule from "../tracker/adapters/linear/index.js";
import * as configLoader from "../config/loader.js";

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

  describe("sync-in persistence", () => {
    let tmpDir: string;
    let consoleSpy: ReturnType<typeof vi.spyOn>;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), "polaris-test-"));
      consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
      consoleSpy.mockRestore();
      consoleLogSpy.mockRestore();
      await rm(tmpDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it("tracker sync-in POL-198 writes .polaris/clusters/POL-198/clusters.json", async () => {
      const fakeGraph: import("../tracker/types.js").ExecutionGraphV2 = {
        schemaVersion: "v2",
        source: { id: "POL-198", type: "Linear" },
        nodes: {
          "POL-198": { id: "POL-198", title: "Root issue", status: "Todo" },
        },
        dependencies: {},
        clusters: {
          "POL-198": { id: "POL-198", title: "Linear Issue: POL-198", children: ["POL-198"] },
        },
        activeCluster: "POL-198",
      };
      const fakeLocalGraph = LocalGraph.fromGraph(fakeGraph);

      vi.spyOn(linearModule.LinearAdapter.prototype, "syncIn").mockResolvedValue(fakeLocalGraph);
      vi.spyOn(configLoader, "loadConfig").mockReturnValue(
        { tracker: { adapter: "linear", linear: { enabled: true } } } as any,
      );

      const command = createTrackerCommand({ repoRoot: tmpDir });
      await command.parseAsync(["node", "tracker", "sync-in", "POL-198"], { from: "node" });

      const expectedPath = path.join(tmpDir, ".polaris", "clusters", "POL-198", "clusters.json");
      const contents = await readFile(expectedPath, "utf-8");
      const parsed = JSON.parse(contents);

      expect(parsed.schemaVersion).toBe("v2");
      expect(parsed.activeCluster).toBe("POL-198");
      expect(parsed.nodes["POL-198"]).toEqual({ id: "POL-198", title: "Root issue", status: "Todo" });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("sync-in complete. Active cluster: POL-198"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining(expectedPath),
      );
    });

    it("tracker sync-in creates the cluster directory if it does not exist", async () => {
      const fakeGraph: import("../tracker/types.js").ExecutionGraphV2 = {
        schemaVersion: "v2",
        source: { id: "POL-999", type: "Linear" },
        nodes: {},
        dependencies: {},
        clusters: {
          "POL-999": { id: "POL-999", title: "Linear Issue: POL-999", children: [] },
        },
        activeCluster: "POL-999",
      };
      const fakeLocalGraph = LocalGraph.fromGraph(fakeGraph);

      vi.spyOn(linearModule.LinearAdapter.prototype, "syncIn").mockResolvedValue(fakeLocalGraph);
      vi.spyOn(configLoader, "loadConfig").mockReturnValue(
        { tracker: { adapter: "linear", linear: { enabled: true } } } as any,
      );

      const command = createTrackerCommand({ repoRoot: tmpDir });
      await command.parseAsync(["node", "tracker", "sync-in", "POL-999"], { from: "node" });

      const expectedPath = path.join(tmpDir, ".polaris", "clusters", "POL-999", "clusters.json");
      const contents = await readFile(expectedPath, "utf-8");
      expect(JSON.parse(contents).schemaVersion).toBe("v2");
    });
  });
});
