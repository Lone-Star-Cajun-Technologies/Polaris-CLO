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
   *   {{worker_prompt}}  - compiled Polaris worker instructions
   */
  args?: string[];
}

export type ExecutionRole =
  | "orchestrator"
  | "startup"
  | "worker"
  | "foreman"
  | "analyst"
  | "analysis"
  | "repair"
  | "librarian"
  | "docs"
  | "finalizer";

export interface RoleExecutionConfig {
  /**
   * Optional adapter override for this role.
   * Defaults to execution.adapter when omitted.
   */
  adapter?: string;
  /**
   * Provider key used for this role.
   * Defaults to execution.rotation[0] or the first configured provider.
   */
  provider?: string;
  /**
   * Optional model identifier passed to provider command templates as {{model}}.
   */
  model?: string;
  /**
   * Optional command override for this role. When present, it is materialized
   * as a provider config before dispatch.
   */
  command?: string;
  /** Optional command args override for this role. */
  args?: string[];
}

/** Governance policy for provider selection for a given role. */
export interface RoleProviderPolicy {
  /**
   * Ordered provider list for this role.
   * An empty array means the role is disabled.
   */
  providers: string[];
  /**
   * Whether native same-session subagent dispatch is permitted for this role.
   */
  allowNativeSubagent?: boolean;
  /**
   * Whether provider fallback is disallowed for this role.
   */
  noFallback?: boolean;
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
   * Experimental: ordered list of provider names for cross-run load rotation.
   * Off by default (empty array). When non-empty, overrides providerPolicy
   * ordering — the rotation list is filtered by the role policy rather than
   * the role policy acting as a priority list. Leave empty unless intentionally
   * enabling rotation; use providerPolicy.providers ordering instead.
   */
  rotation?: string[];

  /**
   * If false (default), a failed provider does not automatically retry with another.
   */
  allowCrossAgentFallback?: boolean;

  /**
   * Role-specific provider selection. Polaris owns dispatch and state; each
   * role entry only selects the adapter/provider/model used to invoke an agent.
   */
  roles?: Partial<Record<ExecutionRole, RoleExecutionConfig>>;
  /**
   * Per-role provider governance policy.
   */
  providerPolicy?: Partial<Record<ExecutionRole, RoleProviderPolicy>>;
}

export interface SkillPacketConfig {
  /**
   * Minimum confidence required for analyze packets before auto-creating
   * deeper analysis issues. Default: 85.
   */
  analysis_confidence_threshold?: number;
  /**
   * When false (default), agent must ask user before spawning secondary
   * analysis issues if confidence is below the threshold.
   */
  auto_deep_analysis?: boolean;
  /**
   * When false (default), cross-provider delegation is forbidden.
   * Only internal child/subagent fallback is used for run packets.
   */
  allow_cross_provider_delegation?: boolean;
}

export type GraphInvalidationTrigger = "repo-change" | "config-change";

export interface GraphConfig {
  outputPath?: string;
  invalidationTriggers?: GraphInvalidationTrigger[];
}

export type NormalizedLifecycleState =
  | "backlog"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled"
  | "no_status_change";

export interface TrackerLifecyclePolicy {
  /**
   * Lifecycle state to apply when a child is dispatched to a worker.
   * Default: "in_progress"
   */
  childOnDispatch?: NormalizedLifecycleState;
  /**
   * Lifecycle state to apply when a child passes validation.
   * Default: "in_review" (review-gated)
   */
  childOnValidationPassed?: NormalizedLifecycleState;
  /**
   * Lifecycle state to apply when a child's work is merged.
   * Default: "done"
   */
  childOnMerged?: NormalizedLifecycleState;
  /**
   * Lifecycle state to apply when a parent has all children complete.
   * Default: "in_review" (review-gated)
   */
  parentOnAllChildrenComplete?: NormalizedLifecycleState;
  /**
   * Lifecycle state to apply when a parent's delivery is merged.
   * Default: "done"
   */
  parentOnDeliveryMerged?: NormalizedLifecycleState;
  /**
   * Lifecycle state to apply when a child requires triage.
   * Default: "blocked"
   */
  childOnTriageRequired?: NormalizedLifecycleState;
  /**
   * Lifecycle state to apply when provider fails before repo work.
   * Default: "no_status_change" (avoid false implementation failures)
   */
  providerFailureBeforeWork?: NormalizedLifecycleState;
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
  graph?: GraphConfig;
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
    /** Which remote tracker adapter to use. Omit to disable remote reconciliation. */
    adapter?: "linear" | "mcp-bridge" | "local" | "github" | "jira";
    /** Tracker lifecycle policy with normalized transition states. */
    lifecyclePolicy?: TrackerLifecyclePolicy;
    'local-file'?: {
      enabled?: boolean;
    };
    linear?: {
      enabled?: boolean;
      teamId?: string;
      projectId?: string;
    };
    mcpBridge?: {
      enabled?: boolean;
    };
    /** Configuration for the GitHub Issues tracker adapter. */
    github?: {
      enabled?: boolean;
      /** GitHub repository owner (user or org). */
      owner?: string;
      /** GitHub repository name. */
      repo?: string;
      /** GitHub personal access token with repo scope. */
      token?: string;
      /** Label prefix for lifecycle state labels. Default: "status:". */
      labelPrefix?: string;
    };
    /** Configuration for the Jira Cloud tracker adapter. */
    jira?: {
      enabled?: boolean;
      /** Jira Cloud base URL, e.g. "https://your-domain.atlassian.net". */
      baseUrl?: string;
      /** Atlassian account email address. */
      email?: string;
      /** Jira API token. */
      apiToken?: string;
      /** Jira project key, e.g. "POL". */
      projectKey?: string;
      /** Optional override for native status name → normalized lifecycle state mapping. */
      statusMappings?: Record<string, NormalizedLifecycleState>;
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
  skill_packet?: SkillPacketConfig;
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
