export interface ProviderConfig {
  /**
   * Executable name or absolute path. May contain $ENV_VAR references.
   * Example: "codex", "/usr/local/bin/gemini", "$POLARIS_AGENT"
   */
  command: string;
  /**
   * Additional CLI arguments. Supports template variables:
   *   {{active_child}}   - the child task ID being dispatched
   *   {{run_id}}         - current run ID
   *   {{cluster_id}}     - parent cluster ID
   *   {{state_file}}     - absolute path to current-state.json
   *   {{telemetry_file}} - absolute path to telemetry output file
   *   {{packet_json}}    - full bootstrap packet as a JSON string
   *   {{packet_file}}    - path to temp file containing bootstrap packet JSON
   */
  args?: string[];
}

export interface ExecutionConfig {
  /**
   * Adapter to use for external dispatch. Currently supported: "terminal-cli"
   * Future: "agent-subtask" (Claude subagent workflows)
   */
  adapter: string;

  /**
   * Named provider configurations. Keys are provider names (e.g. "codex", "gemini", "custom").
   */
  providers: Record<string, ProviderConfig>;

  /**
   * Ordered list of provider names for sequential rotation.
   * When --provider is not specified, the first entry is used.
   */
  rotation?: string[];

  /**
   * If false (default), a failed provider does not automatically retry with another.
   */
  allowCrossAgentFallback?: boolean;
}

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
  /** Configuration for external agent dispatch via terminal-cli adapter. */
  execution?: ExecutionConfig;
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
