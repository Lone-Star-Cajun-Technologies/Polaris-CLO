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

export type WorkerProviderCapability =
  | "orchestration"
  | "analysis"
  | "implementation"
  | "repair"
  | "docs"
  | "finalization";

export type WorkerTaskType =
  | "startup"
  | "analyze"
  | "impl"
  | "repair"
  | "docs"
  | "finalize";

export type WorkerTrustTier = "sandbox" | "standard" | "trusted";
export type WorkerCostTier = "low" | "medium" | "high";
export type WorkerQuotaPolicy = "best-effort" | "rate-limited" | "reserved";

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

export interface WorkerProviderRouterPolicy {
  /** Which execution roles may use this provider in the router pool. */
  eligibleRoles?: ExecutionRole[];
  /** Coarse provider capability tags used for router eligibility filtering. */
  capabilities?: WorkerProviderCapability[];
  /** Fine-grained task-type eligibility for router matching. */
  taskTypes?: WorkerTaskType[];
  /** Trust tier used by policy filtering. */
  trustTier?: WorkerTrustTier;
  /** Relative cost tier used by policy filtering. */
  costTier?: WorkerCostTier;
  /** Quota handling policy for this provider. */
  quotaPolicy?: WorkerQuotaPolicy;
  /** Whether this provider can be used as fallback target. */
  fallbackEligible?: boolean;
  /** Max concurrent worker slots allowed for this provider. */
  maxActiveSlots?: number;
}

export interface WorkerPoolLimits {
  /** Max active workers in the default worker pool. */
  maxActiveWorkers?: number;
  /** Max active slots across the default worker pool. */
  maxActiveSlots?: number;
}

export interface WorkerRouterPolicyConfig {
  /**
   * Default worker pool limits.
   * Defaults preserve single-worker behavior.
   */
  defaultWorkerPool?: WorkerPoolLimits;
  /**
   * Provider metadata registry keyed by execution provider name.
   */
  providerRegistry?: Record<string, WorkerProviderRouterPolicy>;
  /**
   * Explicit router fallback switch.
   * When omitted, legacy allowCrossAgentFallback behavior applies.
   */
  allowCrossProviderFallback?: boolean;
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
  /**
   * Worker router policy surface for provider eligibility and pool limits.
   */
  routerPolicy?: WorkerRouterPolicyConfig;
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
  /**
   * Controls the implementation discipline ladder injected into every worker prompt.
   * - "full": inject the full 6-rung ladder including inline shortcut convention (default)
   * - "lite": inject the ladder without the inline shortcut convention
   * - "off": do not inject; workers receive no simplicity guidance
   * Per-run bypass via `polaris simplicity --bypass` overrides this setting.
   */
  simplicity?: {
    mode?: "full" | "lite" | "off";
  };
  /**
   * Quality Control configuration. When absent or disabled, Polaris behaves
   * exactly as it does today — no QC providers are invoked and no QC artifacts
   * are written.
   */
  qc?: QcConfig;
  /**
   * SOL (Self-Optimization Loop) configuration.
   * Controls history persistence and reporting behavior.
   * When absent, history is disabled and no snapshots are written.
   */
  sol?: SolConfig;
}

/** SOL history configuration. */
export interface SolHistoryConfig {
  /**
   * Enable SOL history persistence.
   * Default: false — no snapshots are written.
   */
  enabled?: boolean;
  /**
   * Path (relative to repo root) where SOL history is stored.
   * Default: ".polaris/sol-history".
   */
  path?: string;
}

/** SOL subsystem configuration. */
export interface SolConfig {
  /** History persistence settings. */
  history?: SolHistoryConfig;
}

/** QC trigger timing. */
export type QcTriggerMode = "pr" | "completed-cluster" | "child";

/** Normalized QC severity level. */
export type QcSeverity = "critical" | "high" | "medium" | "low" | "info";

/** Provider review mode. */
export type QcProviderMode = "local" | "pr" | "metrics-import";

/** Auto-fix policy. */
export type QcAutoFixPolicy = "disabled" | "dry-run" | "apply";

/** Aggregate repair-routing policy for findings that remain open. */
export type QcRepairRoutingPolicy = "block" | "route" | "follow-up" | "log";

/** QC provider output format. */
export type QcProviderOutputFormat = "json" | "jsonl" | "sarif" | "generic";

/** Action taken when a provider failure occurs. */
export type QcFailureAction = "fail" | "fallback" | "ignore" | "block";

/** Provider-agnostic command and output parsing configuration. */
export interface QcProviderExecutionConfig {
  /**
   * Executable name or absolute path. May contain $ENV_VAR references.
   * Example: "coderabbit", "/usr/local/bin/cr", "$POLARIS_CODERABBIT"
   */
  command: string;
  /**
   * Additional CLI arguments. Supports the same template variables as
   * execution.providers args.
   */
  args?: string[];
  /**
   * Output format and parser hint for this provider.
   */
  output?: {
    /** Output encoding format. */
    format?: QcProviderOutputFormat;
    /** Parser identifier. "coderabbit" uses the built-in CodeRabbit parser. */
    parser?: string;
  };
  /**
   * Explicit provider configuration file path.
   * Example: ".polaris/coderabbit.config.yaml"
   */
  configPath?: string;
}

/** Failure policy for a single QC provider. */
export interface QcProviderFailurePolicy {
  /** Action when the provider times out. Default: "fail". */
  timeout?: QcFailureAction;
  /** Action when provider output cannot be parsed. Default: "fail". */
  parseFailure?: QcFailureAction;
  /** Action when every configured provider fails. Default: "block". */
  allProvidersFailed?: QcFailureAction;
}

/** Rate-limit policy for a QC provider. */
export interface QcProviderRateLimit {
  /** Maximum requests per minute. */
  requestsPerMinute?: number;
  /** Maximum concurrent invocations. */
  maxConcurrent?: number;
}

/** Retry policy for a QC provider. */
export interface QcProviderRetryPolicy {
  /** Maximum retry attempts after a recoverable failure. */
  maxRetries?: number;
  /** Backoff delay in milliseconds between retries. */
  backoffMs?: number;
}

/** Per-provider artifact handling policy. */
export interface QcProviderArtifactPolicy {
  /** Whether to retain raw provider output when safe and non-secret. */
  retainRawOutput?: boolean;
  /** Directory (relative to repo root) for provider artifacts. */
  outputDir?: string;
}

/** Capability flags advertised by a QC provider. */
export type QcProviderCapability =
  | "diff-review"
  | "pr-review"
  | "result-parsing"
  | "auto-fix"
  | "metrics-import";

/** Severity threshold configuration. */
export interface QcSeverityThresholds {
  /**
   * Severity level that blocks delivery by default.
   * Default: "high".
   */
  block?: QcSeverity;
  /**
   * Severity level that routes to repair by default.
   * Default: "medium".
   */
  repair?: QcSeverity;
  /**
   * Severity level that creates follow-up issues by default.
   * Default: "low".
   */
  followUp?: QcSeverity;
}

/** Per-provider configuration entry. */
export interface QcProviderConfig {
  /** Provider name (e.g. "coderabbit", "pr-agent"). */
  name: string;
  /** Review mode. */
  mode: QcProviderMode;
  /** Advertised capabilities. */
  capabilities?: QcProviderCapability[];
  /**
   * Default trigger for this provider.
   * When omitted, Polaris picks a sensible default based on mode.
   */
  trigger?: QcTriggerMode;
  /**
   * Whether this provider is eligible for auto-fix attempts.
   * Default: false.
   */
  autoFixEligible?: boolean;
  /**
   * Provider-specific label → normalized severity mapping.
   * Labels that cannot be mapped land in "info" with provider-uncertain reason.
   */
  severityMapping?: Record<string, QcSeverity>;
  /**
   * Whether this provider is enabled.
   * Default: true.
   */
  enabled?: boolean;
  /**
   * Provider-agnostic command and output parsing configuration.
   * When omitted, built-in provider behavior is used (e.g. hardcoded CodeRabbit command).
   */
  execution?: QcProviderExecutionConfig;
  /**
   * Timeout in milliseconds for a single provider invocation.
   * When omitted, the runner default is used.
   */
  timeoutMs?: number;
  /**
   * Whether this provider is the primary provider in its trigger group.
   * Primary providers are tried before non-primary providers.
   */
  primary?: boolean;
  /**
   * Ordered list of fallback provider names when this provider fails.
   * References must match keys in qc.providers.
   */
  fallback?: string[];
  /**
   * Per-provider failure policy.
   */
  failurePolicy?: QcProviderFailurePolicy;
  /**
   * Rate-limit policy for this provider.
   */
  rateLimit?: QcProviderRateLimit;
  /**
   * Retry policy for this provider.
   */
  retry?: QcProviderRetryPolicy;
  /**
   * Artifact handling policy for this provider.
   */
  artifactPolicy?: QcProviderArtifactPolicy;
}

/** Per-route QC policy override. */
export interface QcRoutePolicy {
  /**
   * Enable child-level QC for this route.
   * Default: false.
   */
  childLevel?: boolean;
  /**
   * Minimum severity required to block delivery for findings on this route.
   */
  blockThreshold?: QcSeverity;
  /**
   * Auto-fix policy override for this route.
   */
  autoFix?: QcAutoFixPolicy;
}

/** Artifact retention policy. */
export interface QcArtifactRetention {
  /**
   * Whether to retain raw provider output when safe and non-secret.
   * Default: false.
   */
  retainRawOutput?: boolean;
  /**
   * Maximum number of QC run artifacts to retain per cluster.
   * Default: 10.
   */
  maxRuns?: number;
}

/** Quality Control subsystem configuration. */
export interface QcConfig {
  /**
   * Master QC enablement switch.
   * Default: false.
   */
  enabled?: boolean;
  /**
   * Default trigger for all configured providers.
   * Default: "completed-cluster".
   */
  defaultTrigger?: QcTriggerMode;
  /**
   * Configured QC providers. Keys are provider names.
   */
  providers?: Record<string, QcProviderConfig>;
  /**
   * Severity thresholds applied to normalized findings.
   */
  severityThresholds?: QcSeverityThresholds;
  /**
   * Auto-fix policy.
   * Default: "disabled".
   */
  autoFix?: QcAutoFixPolicy;
  /**
   * Aggregate repair-routing policy.
   * Default: "route".
   */
  repairRouting?: QcRepairRoutingPolicy;
  /**
   * Artifact retention policy.
   */
  artifactRetention?: QcArtifactRetention;
  /**
   * Per-route QC policy overrides keyed by route name.
   */
  routes?: Record<string, QcRoutePolicy>;
  /**
   * Maximum number of QC repair rounds the governed loop will run before
   * escalating with terminal outcome "max-rounds".
   * Default: 2.
   */
  maxRepairRounds?: number;
}
