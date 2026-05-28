import type { PolarisConfig } from "./schema.js";

export const DEFAULT_CONFIG: Omit<Required<PolarisConfig>, "canon" | "providers" | "orchestration"> & { canon: Required<NonNullable<PolarisConfig["canon"]>>; providers: { repoAnalysis: { preferred: string | undefined; fallback: string[] } }; orchestration: Required<NonNullable<PolarisConfig["orchestration"]>> } & { compact: Required<Pick<NonNullable<PolarisConfig["compact"]>, "orchestratorMode" | "workerMode">> } = {
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
  orchestration: {
    mode: "auto",
    auto_finalize: false,
    notification_format: "terse",
  },
  execution: {
    adapter: "terminal-cli",
    providers: {},
    rotation: [],
    allowCrossAgentFallback: false,
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
    max_children: 3,
    stop_on_fail: false,
    allow_analyze_children: false,
  },
  compact: {
    orchestratorMode: "standard",
    workerMode: "standard",
  },
};
