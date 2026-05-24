import type { PolarisConfig } from "./schema.js";

export const DEFAULT_CONFIG: Required<PolarisConfig> = {
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
  execution: {
    adapter: "terminal-cli",
    providers: {},
    rotation: [],
    allowCrossAgentFallback: false,
  },
};
