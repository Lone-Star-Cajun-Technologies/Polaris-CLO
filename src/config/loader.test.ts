import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { loadConfig } from "./loader.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

const mockedReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DEFAULT_QC = {
  enabled: false,
  defaultTrigger: "completed-cluster",
  providers: {},
  severityThresholds: { block: "high", repair: "medium", followUp: "low" },
  autoFix: "disabled",
  repairRouting: "route",
  artifactRetention: { retainRawOutput: false, maxRuns: 10 },
  routes: {},
};

describe("loadConfig", () => {
  it("deep-merges adoption lock fields without clobbering nested config", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: "1.0",
        execution: {
          providers: { codex: { command: "codex" } },
          roles: { worker: { provider: "codex", model: "gpt-5.5" } },
          rotation: [],
          allowCrossAgentFallback: false,
          adapter: "terminal-cli",
        },
        orchestration: {
          mode: "supervised",
          auto_finalize: true,
        },
        providers: {
          repoAnalysis: {
            preferred: "gitnexus",
            fallback: ["polaris-map"],
          },
        },
        graph: {
          outputPath: ".custom/graph",
        },
      }),
    );

    const config = loadConfig("/fake-repo");

    expect(config.execution.providers).toEqual({ codex: { command: "codex" } });
    expect(config.execution.roles).toEqual({
      worker: { provider: "codex", model: "gpt-5.5" },
    });
    expect(config.execution.routerPolicy).toEqual({
      defaultWorkerPool: {
        maxActiveWorkers: 1,
        maxActiveSlots: 1,
      },
      providerRegistry: {},
      allowCrossProviderFallback: false,
    });
    expect(config.orchestration).toMatchObject({
      mode: "supervised",
      auto_finalize: true,
      notification_format: "terse",
    });
    expect(config.providers.repoAnalysis).toEqual({
      preferred: "gitnexus",
      fallback: ["polaris-map"],
    });
    expect(config.graph).toEqual({
      outputPath: ".custom/graph",
      invalidationTriggers: ["repo-change", "config-change"],
    });
  });

  it("loads default graph artifact governance config", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    const config = loadConfig("/fake-repo");

    expect(config.graph).toEqual({
      outputPath: ".polaris/graph",
      invalidationTriggers: ["repo-change", "config-change"],
    });
    expect(config.execution.routerPolicy).toEqual({
      defaultWorkerPool: {
        maxActiveWorkers: 1,
        maxActiveSlots: 1,
      },
      providerRegistry: {},
      allowCrossProviderFallback: false,
    });
  });

  it("loads default QC config when qc is absent", () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ version: "1.0" }));

    const config = loadConfig("/fake-repo");

    expect(config.qc).toEqual(DEFAULT_QC);
  });

  it("preserves user QC config while filling defaults", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "pr",
          providers: {
            coderabbit: {
              name: "coderabbit",
              mode: "pr",
              capabilities: ["pr-review", "auto-fix"],
              autoFixEligible: true,
            },
          },
          severityThresholds: { block: "critical", repair: "high" },
        },
      }),
    );

    const config = loadConfig("/fake-repo");

    expect(config.qc).toEqual({
      enabled: true,
      defaultTrigger: "pr",
      providers: {
        coderabbit: {
          name: "coderabbit",
          mode: "pr",
          capabilities: ["pr-review", "auto-fix"],
          autoFixEligible: true,
        },
      },
      severityThresholds: { block: "critical", repair: "high", followUp: "low" },
      autoFix: "disabled",
      repairRouting: "route",
      artifactRetention: { retainRawOutput: false, maxRuns: 10 },
      routes: {},
    });
  });
});
