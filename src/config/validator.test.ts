import { describe, it, expect } from "vitest";
import { validateConfig } from "./validator.js";

describe("validateConfig — graph", () => {
  it("accepts config with no graph field", () => {
    const result = validateConfig({ version: "1.0" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts empty graph object", () => {
    const result = validateConfig({ graph: {} });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts valid graph output path and invalidation triggers", () => {
    const result = validateConfig({
      graph: {
        outputPath: ".polaris/graph",
        invalidationTriggers: ["repo-change", "config-change"],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects graph that is not an object", () => {
    const result = validateConfig({ graph: ".polaris/graph" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("graph must be an object");
  });

  it("rejects graph.outputPath that is not a string", () => {
    const result = validateConfig({ graph: { outputPath: 42 } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("graph.outputPath must be a string");
  });

  it("rejects graph.invalidationTriggers that is not an array", () => {
    const result = validateConfig({
      graph: { invalidationTriggers: "repo-change" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'graph.invalidationTriggers must contain only "repo-change" or "config-change"',
    );
  });

  it("rejects unsupported graph invalidation trigger values", () => {
    const result = validateConfig({
      graph: { invalidationTriggers: ["repo-change", "manual"] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'graph.invalidationTriggers must contain only "repo-change" or "config-change"',
    );
  });

  it("does not warn on the graph key", () => {
    const result = validateConfig({ graph: { outputPath: ".polaris/graph" } });
    expect(result.warnings).not.toContain('Unknown config field: "graph"');
  });
});

describe("validateConfig — providers", () => {
  it("accepts config with no providers field", () => {
    const result = validateConfig({ version: "1.0" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts empty providers object", () => {
    const result = validateConfig({ providers: {} });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts valid providers.repoAnalysis with preferred and fallback", () => {
    const result = validateConfig({
      providers: {
        repoAnalysis: {
          preferred: "gitnexus",
          fallback: ["polaris-map", "ripgrep"],
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts providers.repoAnalysis with only preferred", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { preferred: "gitnexus" } },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts providers.repoAnalysis with only fallback", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { fallback: ["polaris-map"] } },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects providers that is not an object", () => {
    const result = validateConfig({ providers: "gitnexus" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("providers must be an object");
  });

  it("rejects providers.repoAnalysis that is not an object", () => {
    const result = validateConfig({ providers: { repoAnalysis: 42 } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("providers.repoAnalysis must be an object");
  });

  it("rejects providers.repoAnalysis.preferred that is not a string", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { preferred: 123 } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "providers.repoAnalysis.preferred must be a string",
    );
  });

  it("rejects providers.repoAnalysis.fallback that is not an array of strings", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { fallback: "polaris-map" } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "providers.repoAnalysis.fallback must be an array of strings",
    );
  });

  it("rejects providers.repoAnalysis.fallback with non-string elements", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { fallback: [1, 2] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "providers.repoAnalysis.fallback must be an array of strings",
    );
  });

  it("does not warn on the providers key", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { preferred: "gitnexus" } },
    });
    expect(result.warnings).not.toContain('Unknown config field: "providers"');
  });
});

describe("validateConfig — compact", () => {
  it("accepts config with no compact field", () => {
    const result = validateConfig({ version: "1.0" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts empty compact object", () => {
    const result = validateConfig({ compact: {} });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts compact.orchestratorMode standard", () => {
    const result = validateConfig({ compact: { orchestratorMode: "standard" } });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts compact.orchestratorMode strict", () => {
    const result = validateConfig({ compact: { orchestratorMode: "strict" } });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts compact.workerMode standard", () => {
    const result = validateConfig({ compact: { workerMode: "standard" } });
    expect(result.valid).toBe(true);
  });

  it("accepts compact.workerMode strict", () => {
    const result = validateConfig({ compact: { workerMode: "strict" } });
    expect(result.valid).toBe(true);
  });

  it("accepts compact.workerMode minimal", () => {
    const result = validateConfig({ compact: { workerMode: "minimal" } });
    expect(result.valid).toBe(true);
  });

  it("accepts compact.level standard", () => {
    const result = validateConfig({ compact: { level: "standard" } });
    expect(result.valid).toBe(true);
  });

  it("accepts compact.level strict", () => {
    const result = validateConfig({ compact: { level: "strict" } });
    expect(result.valid).toBe(true);
  });

  it("accepts compact.level minimal", () => {
    const result = validateConfig({ compact: { level: "minimal" } });
    expect(result.valid).toBe(true);
  });

  it("accepts all compact fields together", () => {
    const result = validateConfig({
      compact: { orchestratorMode: "strict", workerMode: "minimal", level: "strict" },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects compact that is not an object", () => {
    const result = validateConfig({ compact: "standard" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("compact must be an object");
  });

  it("rejects invalid compact.orchestratorMode", () => {
    const result = validateConfig({ compact: { orchestratorMode: "minimal" } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('compact.orchestratorMode must be either "standard" or "strict"');
  });

  it("rejects non-string compact.orchestratorMode", () => {
    const result = validateConfig({ compact: { orchestratorMode: 42 } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('compact.orchestratorMode must be either "standard" or "strict"');
  });

  it("rejects invalid compact.workerMode", () => {
    const result = validateConfig({ compact: { workerMode: "aggressive" } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('compact.workerMode must be one of "standard", "strict", "minimal"');
  });

  it("rejects non-string compact.workerMode", () => {
    const result = validateConfig({ compact: { workerMode: true } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('compact.workerMode must be one of "standard", "strict", "minimal"');
  });

  it("rejects invalid compact.level", () => {
    const result = validateConfig({ compact: { level: "verbose" } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('compact.level must be one of "standard", "strict", "minimal"');
  });

  it("rejects non-string compact.level", () => {
    const result = validateConfig({ compact: { level: 0 } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('compact.level must be one of "standard", "strict", "minimal"');
  });

  it("does not warn on the compact key", () => {
    const result = validateConfig({ compact: { orchestratorMode: "standard" } });
    expect(result.warnings).not.toContain('Unknown config field: "compact"');
  });
});

describe("validateConfig — execution roles", () => {
  it("accepts role-specific provider, adapter, command, args, and model assignments", () => {
    const result = validateConfig({
      execution: {
        adapter: "terminal-cli",
        providers: {
          worker: { command: "codex" },
          finalizer: { command: "codex", args: ["--model", "{{model}}"] },
        },
        roles: {
          orchestrator: { provider: "worker", model: "gpt-5.4" },
          worker: { provider: "worker" },
          analyst: { provider: "worker" },
          repair: { provider: "worker" },
          librarian: { provider: "worker" },
          finalizer: {
            adapter: "terminal-cli",
            provider: "finalizer",
            command: "codex",
            args: ["--model", "gpt-5.4"],
            model: "gpt-5.4",
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects unknown execution role names", () => {
    const result = validateConfig({
      execution: {
        roles: {
          madeUpRole: { provider: "worker" },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.roles contains unsupported role: madeUpRole");
  });
});

describe("validateConfig — execution providerPolicy", () => {
  it("remains backward compatible when providerPolicy is omitted", () => {
    const result = validateConfig({
      execution: {
        adapter: "terminal-cli",
        providers: {
          copilot: { command: "copilot" },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts valid role provider policy config", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
          codex: { command: "codex" },
        },
        providerPolicy: {
          worker: {
            providers: ["copilot", "codex"],
            allowNativeSubagent: false,
            noFallback: false,
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts empty providers list for a disabled role", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
        },
        providerPolicy: {
          librarian: {
            providers: [],
            noFallback: true,
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects provider policy entries that reference undefined providers", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
        },
        providerPolicy: {
          worker: {
            providers: ["copilot", "claude"],
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.providerPolicy.worker.providers contains unknown provider: claude");
  });
});
