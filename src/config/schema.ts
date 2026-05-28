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
  orchestration?: {
    /**
     * Orchestration mode.
     * - "supervised": stop after each child and wait for operator confirmation (default)
     * - "auto": run the entire cluster from start to finish without interruption
     */
    mode?: "supervised" | "auto";
    /**
     * If true, automatically finalize the run after all children are complete (only in auto mode).
     * Default: false.
     */
    auto_finalize?: boolean;
    /**
     * Notification format for orchestration events.
     * - "verbose": detailed, human-readable status updates (default for supervised mode)
     * - "terse": compact, single-line status updates for logs (default for auto mode)
     */
    notification_format?: "verbose" | "terse";
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
    'local-file'?: {
      enabled?: boolean;
    };
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
    /**
     * Compaction providers detected by `polaris init`.
     * Supported values: "caveman", "gitnexus".
     * Omit the field (or leave as empty array) when no providers are detected.
     */
    compactionProviders?: string[];
  };
  budget?: {
    /**
     * Budget enforcement mode.
     * - "fixed-cap": stop after max_children children (default)
     * - "run-until-done": run all open children without a cap
     * - "stop-on-fail": halt immediately when any child returns status "failed"
     */
    mode?: "fixed-cap" | "run-until-done" | "stop-on-fail";
    /** Maximum children per session (only used in fixed-cap mode). Default: 3. */
    max_children?: number;
    /** If true, halt immediately when a child returns status "failed". Default: false. */
    stop_on_fail?: boolean;
    /** If true, allow analyze-type children to run in an impl session. Default: false. */
    allow_analyze_children?: boolean;
  };
  /**
   * Controls compaction behavior for orchestrator and worker sessions.
   * Compaction determines how aggressively context is trimmed as conversation grows.
   */
  compact?: {
    /**
     * Compaction mode for orchestrator sessions.
     * - "standard": default compaction behavior (default)
     * - "strict": aggressive compaction; prune more aggressively to stay within budget
     */
    orchestratorMode?: "standard" | "strict";
    /**
     * Compaction mode for worker sessions.
     * - "standard": default compaction behavior (default)
     * - "strict": aggressive compaction; prune more aggressively
     * - "minimal": minimal compaction; preserve as much context as possible
     */
    workerMode?: "standard" | "strict" | "minimal";
    /**
     * Shorthand that sets both orchestratorMode and workerMode when neither is
     * specified individually. Ignored if orchestratorMode or workerMode is set.
     */
    level?: "standard" | "strict" | "minimal";
  };
}
