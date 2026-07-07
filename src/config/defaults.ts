import type { PolarisConfig } from "./schema.js";

export const DEFAULT_CONFIG: Omit<Required<PolarisConfig>, "canon" | "providers" | "orchestration" | "simplicity" | "qc"> & { canon: Required<NonNullable<PolarisConfig["canon"]>>; providers: { repoAnalysis: { preferred: string | undefined; fallback: string[] } }; orchestration: Required<NonNullable<PolarisConfig["orchestration"]>>; qc: Required<NonNullable<PolarisConfig["qc"]>> } & { compact: Required<Pick<NonNullable<PolarisConfig["compact"]>, "orchestratorMode" | "workerMode">> } = {
  version: "1.0",
  repo: {
    name: "",
    sourceRoots: ["src"],
    docsRoots: [],
    taskchainRoots: [],
    generatedRoots: [],
    sidecarOutputPath: ".polaris/map",
  },
  map: {
    confidenceThreshold: 0.75,
    autoWriteAbove: 0.85,
    reviewRequiredBelow: 0.75,
    inferenceRules: [],
    onLowConfidence: "warn",
  },
  loop: {
    bootstrapOutputPath: ".polaris/bootstrap",
    analyzeImplBoundaryEnforced: true,
    sessionTerminationMode: "emit-marker",
    allowBranchDivergence: false,
  },
  graph: {
    outputPath: ".polaris/graph",
    invalidationTriggers: ["repo-change", "config-change"],
  },
  orchestration: {
    mode: "supervised",
    auto_finalize: false,
    notification_format: "terse",
  },
  execution: {
    adapter: "terminal-cli",
    providers: {},
    rotation: [],
    allowCrossAgentFallback: false,
    roles: {},
    routerPolicy: {
      defaultWorkerPool: {
        maxActiveWorkers: 1,
        maxActiveSlots: 1,
      },
      providerRegistry: {},
      allowCrossProviderFallback: false,
    },
  },
  finalize: {
    targetBranch: "main",
    prDraft: true,
    runChecks: [],
    requireMapValidation: true,
    requireSchemaValidation: true,
    archiveRunSnapshot: true,
  },
  tracker: {
    lifecyclePolicy: {
      childOnDispatch: "in_progress",
      childOnValidationPassed: "in_review",
      childOnMerged: "done",
      parentOnAllChildrenComplete: "in_review",
      parentOnDeliveryMerged: "done",
      childOnTriageRequired: "blocked",
      providerFailureBeforeWork: "no_status_change",
    },
    linear: {
      enabled: false,
      teamId: "",
      projectId: "",
    },
  },
  integrations: {
    github: {
      owner: "",
      repo: "",
    },
  },
  canon: {
    checkOnContinue: true,
    checkOnFinalize: true,
  },
  providers: {
    repoAnalysis: {
      preferred: undefined as string | undefined,
      fallback: ["polaris-map", "ripgrep"],
    },
  },
  budget: {
    mode: "fixed-cap" as "fixed-cap" | "run-until-done" | "stop-on-fail",
    max_children: 6,
    stop_on_fail: false,
    allow_analyze_children: false,
  },
  compact: {
    orchestratorMode: "standard",
    workerMode: "standard",
  },
  skill_packet: {
    analysis_confidence_threshold: 85,
    auto_deep_analysis: false,
    allow_cross_provider_delegation: false,
  },
  qc: {
    enabled: false,
    defaultTrigger: "completed-cluster",
    providers: {},
    severityThresholds: {
      block: "high",
      repair: "medium",
      followUp: "low",
    },
    autoFix: "disabled",
    repairRouting: "route",
    artifactRetention: {
      retainRawOutput: false,
      maxRuns: 10,
    },
    routes: {},
  },
};
