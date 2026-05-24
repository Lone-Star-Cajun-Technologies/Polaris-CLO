import type { PolarisConfig } from "./schema.js";

export const DEFAULT_CONFIG: Omit<Required<PolarisConfig>, "canon" | "providers"> & { canon: Required<NonNullable<PolarisConfig["canon"]>>; providers: { repoAnalysis: { preferred: string | undefined; fallback: string[] } } } = {
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
};
