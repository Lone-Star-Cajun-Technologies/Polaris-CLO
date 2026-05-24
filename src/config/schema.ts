export interface PolarisConfig {
  version?: string;
  repo?: {
    name?: string;
    sourceRoots?: string[];
    docsRoots?: string[];
    taskchainRoots?: string[];
    generatedRoots?: string[];
    sidecarOutputPath?: string;
  };
  map?: {
    confidenceThreshold?: number;
    autoWriteAbove?: number;
    reviewRequiredBelow?: number;
    inferenceRules?: string[];
    onLowConfidence?: "warn" | "fail";
  };
  loop?: {
    bootstrapOutputPath?: string;
    analyzeImplBoundaryEnforced?: boolean;
    sessionTerminationMode?: "emit-marker" | "exit-0";
    allowBranchDivergence?: boolean;
  };
  execution?: {
    adapter?: "agent-subtask" | "terminal-cli" | "ci" | "ssh" | "remote-worker" | "cross-agent";
    allowCrossAgentFallback?: boolean;
  };
  finalize?: {
    targetBranch?: string;
    prDraft?: boolean;
    runChecks?: string[];
    requireMapValidation?: boolean;
    requireSchemaValidation?: boolean;
    archiveRunSnapshot?: boolean;
  };
  tracker?: {
    linear?: {
      enabled?: boolean;
      teamId?: string;
      projectId?: string;
    };
  };
  integrations?: {
    github?: {
      owner?: string;
      repo?: string;
    };
  };
  canon?: {
    checkOnContinue?: boolean;
    checkOnFinalize?: boolean;
  };
  providers?: {
    repoAnalysis?: {
      preferred?: string;
      fallback?: string[];
    };
  };
}
