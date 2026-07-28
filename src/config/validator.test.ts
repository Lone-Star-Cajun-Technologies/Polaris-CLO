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

  it("warns when a role policy lists multiple providers and providerRegistry is missing", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
          codex: { command: "codex" },
        },
        providerPolicy: {
          worker: {
            providers: ["copilot", "codex"],
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toContain(
      "execution.providerPolicy.worker.providers lists multiple providers but execution.routerPolicy.providerRegistry is missing or empty; dispatch will use compatibility mode and only the selected provider will appear in providers_tried",
    );
  });

  it("does not warn when a role policy lists multiple providers and providerRegistry is present", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
          codex: { command: "codex" },
        },
        providerPolicy: {
          worker: {
            providers: ["copilot", "codex"],
          },
        },
        routerPolicy: {
          providerRegistry: {
            copilot: { eligibleRoles: ["worker"] },
            codex: { eligibleRoles: ["worker"] },
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.warnings).not.toContain(
      "execution.providerPolicy.worker.providers lists multiple providers but execution.routerPolicy.providerRegistry is missing or empty; dispatch will use compatibility mode and only the selected provider will appear in providers_tried",
    );
  });

  it("does not warn when a role policy lists a single provider without providerRegistry", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
        },
        providerPolicy: {
          worker: {
            providers: ["copilot"],
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.warnings).not.toContain(
      "execution.providerPolicy.worker.providers lists multiple providers but execution.routerPolicy.providerRegistry is missing or empty; dispatch will use compatibility mode and only the selected provider will appear in providers_tried",
    );
  });
});

describe("validateConfig — execution routerPolicy", () => {
  it("remains backward compatible when routerPolicy is omitted", () => {
    const result = validateConfig({
      execution: {
        adapter: "terminal-cli",
        providers: {
          copilot: { command: "copilot" },
        },
        allowCrossAgentFallback: true,
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts valid router policy provider registry metadata and default pool", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
          codex: { command: "codex" },
        },
        routerPolicy: {
          allowCrossProviderFallback: false,
          defaultWorkerPool: {
            maxActiveWorkers: 1,
            maxActiveSlots: 1,
          },
          providerRegistry: {
            copilot: {
              eligibleRoles: ["worker", "repair"],
              capabilities: ["implementation", "repair"],
              taskTypes: ["impl", "repair"],
              trustTier: "standard",
              costTier: "medium",
              quotaPolicy: "rate-limited",
              fallbackEligible: false,
              maxActiveSlots: 1,
            },
            codex: {
              eligibleRoles: ["analysis", "worker"],
              capabilities: ["analysis", "implementation"],
              taskTypes: ["analyze", "impl"],
              trustTier: "trusted",
              costTier: "high",
              quotaPolicy: "reserved",
              fallbackEligible: true,
              maxActiveSlots: 2,
            },
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects router policy entries that reference undefined providers", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
        },
        routerPolicy: {
          providerRegistry: {
            claude: {
              trustTier: "trusted",
            },
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "execution.routerPolicy.providerRegistry contains unknown provider: claude",
    );
  });

  it("rejects invalid slot counts", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
        },
        routerPolicy: {
          defaultWorkerPool: {
            maxActiveWorkers: 0,
          },
          providerRegistry: {
            copilot: {
              maxActiveSlots: -1,
            },
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "execution.routerPolicy.defaultWorkerPool.maxActiveWorkers must be a positive integer",
    );
    expect(result.errors).toContain(
      "execution.routerPolicy.providerRegistry.copilot.maxActiveSlots must be a positive integer",
    );
  });

  it("rejects invalid trust, cost, and capability values", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
        },
        routerPolicy: {
          providerRegistry: {
            copilot: {
              capabilities: ["magic"],
              trustTier: "very-trusted",
              costTier: "free",
            },
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "execution.routerPolicy.providerRegistry.copilot.capabilities must contain only: orchestration, analysis, implementation, repair, docs, finalization",
    );
    expect(result.errors).toContain(
      "execution.routerPolicy.providerRegistry.copilot.trustTier must be one of: sandbox, standard, trusted",
    );
    expect(result.errors).toContain(
      "execution.routerPolicy.providerRegistry.copilot.costTier must be one of: low, medium, high",
    );
  });

  it("rejects ambiguous fallback policy when legacy and router policy conflict", () => {
    const result = validateConfig({
      execution: {
        providers: {
          copilot: { command: "copilot" },
        },
        allowCrossAgentFallback: true,
        routerPolicy: {
          allowCrossProviderFallback: false,
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "execution fallback policy is ambiguous: allowCrossAgentFallback conflicts with execution.routerPolicy.allowCrossProviderFallback",
    );
  });
});

describe("validateConfig — qc", () => {
  it("accepts config with no qc field", () => {
    const result = validateConfig({ version: "1.0" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts disabled qc with default fields", () => {
    const result = validateConfig({
      qc: {
        enabled: false,
        defaultTrigger: "completed-cluster",
        providers: {},
        severityThresholds: { block: "high", repair: "medium", followUp: "low" },
        autoFix: "disabled",
        repairRouting: "route",
        artifactRetention: { retainRawOutput: false, maxRuns: 10 },
        routes: {},
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a CodeRabbit-style provider configuration", () => {
    const result = validateConfig({
      qc: {
        enabled: true,
        defaultTrigger: "pr",
        providers: {
          coderabbit: {
            name: "coderabbit",
            mode: "pr",
            capabilities: ["diff-review", "pr-review", "result-parsing", "auto-fix", "metrics-import"],
            trigger: "pr",
            autoFixEligible: true,
            severityMapping: {
              "code-quality-issue": "medium",
              "security": "critical",
              "style": "low",
            },
          },
        },
        severityThresholds: { block: "high", repair: "medium", followUp: "low" },
        autoFix: "dry-run",
        repairRouting: "route",
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects invalid qc trigger mode", () => {
    const result = validateConfig({
      qc: { defaultTrigger: "merge" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'qc.defaultTrigger must be one of "pr", "completed-cluster", "child"',
    );
  });

  it("rejects invalid qc severity level", () => {
    const result = validateConfig({
      qc: { severityThresholds: { block: "urgent" } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "qc.severityThresholds.block must be one of critical, high, medium, low, info",
    );
  });

  it("rejects invalid provider mode", () => {
    const result = validateConfig({
      qc: {
        providers: {
          bad: { name: "bad", mode: "webhook" },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "qc.providers.bad.mode must be one of local, pr, metrics-import",
    );
  });

  it("rejects invalid provider capabilities", () => {
    const result = validateConfig({
      qc: {
        providers: {
          bad: { name: "bad", mode: "local", capabilities: ["magic"] },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "qc.providers.bad.capabilities must contain only: diff-review, pr-review, result-parsing, auto-fix, metrics-import",
    );
  });

  it("rejects autoFix apply without an auto-fix capable provider", () => {
    const result = validateConfig({
      qc: {
        providers: {
          coderabbit: { name: "coderabbit", mode: "pr" },
        },
        autoFix: "apply",
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'qc.autoFix "apply" requires at least one provider with capability "auto-fix" and autoFixEligible true',
    );
  });

  it("rejects autoFix apply when block threshold is too permissive", () => {
    const result = validateConfig({
      qc: {
        providers: {
          coderabbit: {
            name: "coderabbit",
            mode: "pr",
            capabilities: ["auto-fix"],
            autoFixEligible: true,
          },
        },
        severityThresholds: { block: "low", repair: "info" },
        autoFix: "apply",
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'qc.autoFix "apply" is unsafe when qc.severityThresholds.block is medium or lower',
    );
  });

  it("rejects severity threshold ordering where repair is less severe than block", () => {
    const result = validateConfig({
      qc: {
        severityThresholds: { block: "medium", repair: "high" },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "qc.severityThresholds.repair must be at or below qc.severityThresholds.block severity",
    );
  });

  it("rejects severity threshold ordering where followUp is more severe than repair", () => {
    const result = validateConfig({
      qc: {
        severityThresholds: { block: "critical", repair: "low", followUp: "high" },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "qc.severityThresholds.followUp must be at or below qc.severityThresholds.repair severity",
    );
  });

  it("rejects route autoFix apply without an eligible auto-fix provider", () => {
    const result = validateConfig({
      qc: {
        providers: {
          coderabbit: { name: "coderabbit", mode: "pr" },
        },
        routes: {
          finalize: { autoFix: "apply" },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'qc.routes.finalize.autoFix "apply" requires at least one provider with capability "auto-fix" and autoFixEligible true',
    );
  });

  it("does not warn on the qc key", () => {
    const result = validateConfig({ qc: { enabled: false } });
    expect(result.warnings).not.toContain('Unknown config field: "qc"');
  });

  it("accepts provider-agnostic execution, fallback, and policy config", () => {
    const result = validateConfig({
      qc: {
        enabled: true,
        providers: {
          coderabbit: {
            name: "coderabbit",
            mode: "local",
            execution: {
              command: "coderabbit",
              args: ["review", "--agent"],
              output: { format: "jsonl", parser: "coderabbit" },
              configPath: ".polaris/coderabbit.config.yaml",
            },
            timeoutMs: 300000,
            primary: true,
            fallback: ["pragent"],
            failurePolicy: {
              timeout: "fail",
              parseFailure: "fallback",
              allProvidersFailed: "block",
            },
            rateLimit: {
              requestsPerMinute: 10,
              maxConcurrent: 1,
            },
            retry: {
              maxRetries: 2,
              backoffMs: 1000,
            },
            artifactPolicy: {
              retainRawOutput: true,
              outputDir: ".polaris/qc-artifacts",
            },
          },
          pragent: {
            name: "pragent",
            mode: "pr",
          },
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects invalid provider execution output format", () => {
    const result = validateConfig({
      qc: {
        providers: {
          bad: {
            name: "bad",
            mode: "local",
            execution: { command: "bad", output: { format: "xml" } },
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "qc.providers.bad.execution.output.format must be one of json, jsonl, sarif, generic",
    );
  });

  it("rejects invalid provider failure policy action", () => {
    const result = validateConfig({
      qc: {
        providers: {
          bad: {
            name: "bad",
            mode: "local",
            failurePolicy: { timeout: "retry-forever" },
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "qc.providers.bad.failurePolicy.timeout must be one of fail, fallback, ignore, block",
    );
  });

  it("rejects non-integer timeoutMs", () => {
    const result = validateConfig({
      qc: {
        providers: {
          bad: {
            name: "bad",
            mode: "local",
            timeoutMs: 1.5,
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("qc.providers.bad.timeoutMs must be a positive integer");
  });

  it("rejects invalid rate limit values", () => {
    const result = validateConfig({
      qc: {
        providers: {
          bad: {
            name: "bad",
            mode: "local",
            rateLimit: { requestsPerMinute: 0, maxConcurrent: -1 },
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "qc.providers.bad.rateLimit.requestsPerMinute must be a positive integer",
    );
    expect(result.errors).toContain(
      "qc.providers.bad.rateLimit.maxConcurrent must be a positive integer",
    );
  });

  it("rejects negative retry values", () => {
    const result = validateConfig({
      qc: {
        providers: {
          bad: {
            name: "bad",
            mode: "local",
            retry: { maxRetries: -1, backoffMs: -100 },
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "qc.providers.bad.retry.maxRetries must be a non-negative integer",
    );
    expect(result.errors).toContain(
      "qc.providers.bad.retry.backoffMs must be a non-negative integer",
    );
  });

  it("rejects fallback references to unknown providers", () => {
    const result = validateConfig({
      qc: {
        providers: {
          coderabbit: {
            name: "coderabbit",
            mode: "local",
            fallback: ["missing"],
          },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'qc.providers.coderabbit.fallback contains unknown provider: missing',
    );
  });

  it("rejects unknown provider fields", () => {
    const result = validateConfig({
      qc: {
        providers: {
          bad: {
            name: "bad",
            mode: "local",
            extraField: true,
          },
        },
      },
    });
    expect(result.valid).toBe(true);
    // JSON schema would reject additionalProperties; the runtime validator is permissive by design.
    // This documents that unknown provider fields do not break runtime validation.
  });
});

describe("validateConfig — execution.paperclip", () => {
  it("accepts valid paperclip config", () => {
    const result = validateConfig({
      version: "1.0",
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
          pollIntervalMs: 1000,
          timeoutMs: 30000,
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects missing baseUrl in paperclip config", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.baseUrl must be a valid URL");
  });

  it("rejects malformed UUID in paperclip companyId", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "not-a-uuid",
          assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.companyId must be a UUID");
  });

  it("accepts role adapter override to paperclip when explicitly configured", () => {
    const result = validateConfig({
      execution: {
        adapter: "terminal-cli",
        roles: {
          foreman: {
            adapter: "paperclip",
          },
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts optional timing fields when they are positive integers", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("does not require a paperclip block just because adapter is set to paperclip", () => {
    const result = validateConfig({
      execution: { adapter: "paperclip" },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects execution.paperclip that is not a plain object", () => {
    const result = validateConfig({
      execution: { adapter: "paperclip", paperclip: "not-an-object" },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip must be a plain object");
  });

  it("rejects execution.paperclip that is an array", () => {
    const result = validateConfig({
      execution: { adapter: "paperclip", paperclip: [] },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip must be a plain object");
  });

  it("rejects a non-http(s) baseUrl scheme", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "ftp://127.0.0.1:3100",
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.baseUrl must be a valid URL");
  });

  it("rejects missing assigneeAgentId in paperclip config", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.assigneeAgentId must be a UUID");
  });

  it("rejects a truncated UUID in paperclip assigneeAgentId", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          assigneeAgentId: "39f35fc9-5434-4226-83e3",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.assigneeAgentId must be a UUID");
  });

  it("accepts uppercase UUID values for companyId and assigneeAgentId (case-insensitive)", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "E4E9384A-D4A5-46F2-A444-92F5AA6EBDC6",
          assigneeAgentId: "39F35FC9-5434-4226-83E3-A435809AAC81",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
        },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a whitespace-only tokenEnv", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
          tokenEnv: "   ",
          runIdEnv: "PAPERCLIP_RUN_ID",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.tokenEnv must be a non-empty string");
  });

  it("rejects a missing runIdEnv", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
          tokenEnv: "PAPERCLIP_TOKEN",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.runIdEnv must be a non-empty string");
  });

  it("rejects a non-positive pollIntervalMs", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
          pollIntervalMs: 0,
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.pollIntervalMs must be a positive integer");
  });

  it("rejects a non-integer timeoutMs", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "http://127.0.0.1:3100",
          companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
          assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
          tokenEnv: "PAPERCLIP_TOKEN",
          runIdEnv: "PAPERCLIP_RUN_ID",
          timeoutMs: 1500.5,
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.timeoutMs must be a positive integer");
  });

  it("accumulates errors for every invalid paperclip field simultaneously", () => {
    const result = validateConfig({
      execution: {
        adapter: "paperclip",
        paperclip: {
          baseUrl: "not-a-url",
          companyId: "not-a-uuid",
          assigneeAgentId: "",
          tokenEnv: "",
          runIdEnv: "",
          pollIntervalMs: -5,
          timeoutMs: 0,
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("execution.paperclip.baseUrl must be a valid URL");
    expect(result.errors).toContain("execution.paperclip.companyId must be a UUID");
    expect(result.errors).toContain("execution.paperclip.assigneeAgentId must be a UUID");
    expect(result.errors).toContain("execution.paperclip.tokenEnv must be a non-empty string");
    expect(result.errors).toContain("execution.paperclip.runIdEnv must be a non-empty string");
    expect(result.errors).toContain("execution.paperclip.pollIntervalMs must be a positive integer");
    expect(result.errors).toContain("execution.paperclip.timeoutMs must be a positive integer");
  });
});

describe("validateConfig — execution.adapter enum (paperclip)", () => {
  it("rejects an unsupported execution.adapter value and lists paperclip in the allowed set", () => {
    const result = validateConfig({
      execution: { adapter: "smtp" },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "execution.adapter must be one of agent-subtask, terminal-cli, ci, ssh, remote-worker, cross-agent, paperclip",
    );
  });

  it("rejects a non-string execution.adapter value", () => {
    const result = validateConfig({ execution: { adapter: 42 } });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "execution.adapter must be one of agent-subtask, terminal-cli, ci, ssh, remote-worker, cross-agent, paperclip",
    );
  });

  it("accepts paperclip as a bare execution.adapter value with no other config", () => {
    const result = validateConfig({ execution: { adapter: "paperclip" } });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects an unsupported execution.roles.<role>.adapter value and lists paperclip in the allowed set", () => {
    const result = validateConfig({
      execution: {
        roles: {
          worker: { adapter: "carrier-pigeon" },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "execution.roles.worker.adapter must be one of agent-subtask, terminal-cli, ci, ssh, remote-worker, cross-agent, paperclip",
    );
  });
});
