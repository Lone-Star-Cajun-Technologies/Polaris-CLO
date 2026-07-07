import type { QcResult } from "./types.js";

/** Review scope passed to a QC provider. */
export interface QcReviewScope {
  /**
   * Local branch to review. Required for local mode.
   */
  branch?: string;
  /**
   * Base ref for diff review. Optional; provider may use repo default.
   */
  baseRef?: string;
  /**
   * Open PR URL. Required for pr mode.
   */
  prUrl?: string;
  /**
   * Cluster identifier for artifact scoping.
   */
  clusterId: string;
  /**
   * Polaris run identifier.
   */
  runId: string;
}

/** Raw provider output plus metadata for parsing. */
export interface QcProviderOutput {
  provider: string;
  stdout?: string;
  stderr?: string;
  exitCode: number;
  artifactPath?: string;
}

/** Imported metrics/findings payload. */
export interface QcMetricsPayload {
  provider: string;
  format: "coderabbit" | "pr-agent" | "generic";
  data: unknown;
}

/**
 * Provider-neutral QC adapter interface.
 *
 * Adapters map provider-specific review output into Polaris-normalized findings.
 * No adapter invokes external services directly during config validation or init.
 */
export interface IQcProvider {
  /** Provider name (e.g. "coderabbit"). */
  readonly name: string;

  /** Supported review modes. */
  readonly supportedModes: ReadonlyArray<"local" | "pr" | "metrics-import">;

  /** Advertised capabilities. */
  readonly capabilities: ReadonlyArray<
    "diff-review" | "pr-review" | "result-parsing" | "auto-fix" | "metrics-import"
  >;

  /**
   * Returns true if this provider can handle the given review scope.
   */
  canReview(scope: QcReviewScope): boolean;

  /**
   * Build the provider-specific command or review invocation for a scope.
   * The returned command is not executed here; callers own execution.
   */
  buildReviewCommand(scope: QcReviewScope): { command: string; args: string[] };

  /**
   * Parse raw provider output into normalized Polaris findings.
   */
  parse(output: QcProviderOutput): QcResult;

  /**
   * Import normalized or provider-specific metrics/findings from another source.
   */
  importMetrics(payload: QcMetricsPayload): QcResult;
}

/**
 * Registry of configured QC providers. The registry is keyed by provider name.
 */
export class QcProviderRegistry {
  private readonly providers = new Map<string, IQcProvider>();

  register(provider: IQcProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): IQcProvider | undefined {
    return this.providers.get(name);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): IQcProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Return providers that can review the given scope, ordered by registration.
   */
  candidatesFor(scope: QcReviewScope): IQcProvider[] {
    return this.list().filter((provider) => provider.canReview(scope));
  }
}
