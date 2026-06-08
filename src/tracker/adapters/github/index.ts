import { request } from "node:https";
import type {
  TrackerCapabilities,
  StatusMappingResult,
  LifecycleTransitionResult,
  CommentResult,
  LinkResult,
  DependencyResult,
  CreateChildResult,
  CapableTrackerAdapter,
} from "../../capabilities.js";
import type { NormalizedLifecycleState } from "../../../config/schema.js";

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the GitHub Issues tracker adapter.
 */
export interface GitHubAdapterConfig {
  /** The repository owner (user or organization). */
  owner: string;
  /** The repository name. */
  repo: string;
  /** A GitHub Personal Access Token (PAT) with repo scope. */
  token: string;
  /**
   * Prefix for lifecycle labels managed by this adapter.
   * Defaults to `"status:"`.
   */
  labelPrefix?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────────────

interface GitHubLabel {
  name: string;
}

interface GitHubIssue {
  number: number;
  state: "open" | "closed";
  labels: GitHubLabel[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal HTTP helper
// ──────────────────────────────────────────────────────────────────────────────

const GITHUB_API_HOSTNAME = "api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Makes a GitHub REST API request using Node.js built-in `https`.
 *
 * @param method  - HTTP method.
 * @param path    - Request path (e.g. `/repos/owner/repo/issues/1`).
 * @param token   - GitHub PAT for Bearer authentication.
 * @param body    - Optional JSON-serializable request body.
 * @returns Parsed JSON response body, or `null` for 204 No Content.
 */
async function githubRequest<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        hostname: GITHUB_API_HOSTNAME,
        path,
        method,
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "polaris-github-adapter",
          ...(payload !== undefined
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 400) {
            const text = Buffer.concat(chunks).toString("utf-8");
            reject(
              new Error(
                `GitHub API returned ${statusCode} for ${method} ${path}: ${text}`,
              ),
            );
            return;
          }
          // 204 No Content
          if (statusCode === 204) {
            resolve(null as unknown as T);
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(
              new Error(
                `Failed to parse GitHub API response: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        });
      },
    );

    req.setTimeout(GITHUB_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`GitHub API request timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Lifecycle state helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Maps a `NormalizedLifecycleState` to the hyphenated label suffix used in
 * GitHub (e.g. `"in_progress"` → `"in-progress"`).
 */
function lifecycleStateToLabelSuffix(state: NormalizedLifecycleState): string {
  return state.replace(/_/g, "-");
}

// ──────────────────────────────────────────────────────────────────────────────
// Adapter
// ──────────────────────────────────────────────────────────────────────────────

/**
 * GitHub Issues tracker adapter.
 *
 * Implements {@link CapableTrackerAdapter} against the GitHub REST API v3,
 * using PAT authentication. Lifecycle states are modelled as open/closed
 * issue state plus `status:*` labels.
 *
 * **Capability summary:**
 * - Status updates: yes (open/closed + labels)
 * - Comments: yes
 * - Lifecycle mapping: yes
 * - Child relationships, links, dependencies: not supported
 */
export class GitHubIssuesAdapter implements CapableTrackerAdapter {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly labelPrefix: string;
  private readonly labelPrefixLower: string;

  /**
   * Creates a new `GitHubIssuesAdapter`.
   *
   * @param config - GitHub adapter configuration.
   */
  constructor(config: GitHubAdapterConfig) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.token = config.token;
    this.labelPrefix = config.labelPrefix ?? "status:";
    this.labelPrefixLower = this.labelPrefix.toLowerCase();
  }

  // ── CapableTrackerAdapter ──────────────────────────────────────────────────

  /**
   * Returns the capabilities supported by the GitHub Issues adapter.
   */
  getCapabilities(): TrackerCapabilities {
    return {
      supportsChildRelationships: false,
      supportsStatusUpdates: true,
      supportsComments: true,
      supportsLinks: false,
      supportsDependencies: false,
      supportsLifecycleMapping: true,
      supportsCreateChild: false,
    };
  }

  /**
   * Maps a GitHub native status string to a {@link NormalizedLifecycleState}.
   *
   * Accepted `nativeStatus` values:
   * - `"open"` → `"in_progress"` (no status label present)
   * - `"closed"` → `"done"`
   * - `"status:in-progress"` → `"in_progress"`
   * - `"status:in-review"` → `"in_review"`
   * - `"status:blocked"` → `"blocked"`
   *
   * @param nativeStatus - GitHub issue state (`"open"` / `"closed"`) or a
   *   `status:*` label string.
   */
  mapNativeStatus(nativeStatus: string): StatusMappingResult {
    const s = nativeStatus.trim().toLowerCase();

    if (s === "closed") {
      return { lifecycleState: "done", supported: true };
    }

    if (s === "open") {
      return { lifecycleState: "in_progress", supported: true };
    }

    // Accept status label strings directly (e.g. from stored label names)
    if (s.startsWith(this.labelPrefixLower)) {
      const suffix = s.slice(this.labelPrefixLower.length); // e.g. "in-progress"
      const normalized = suffix.replace(/-/g, "_") as NormalizedLifecycleState;

      const valid: NormalizedLifecycleState[] = [
        "backlog",
        "in_progress",
        "in_review",
        "done",
        "blocked",
        "cancelled",
        "no_status_change",
      ];

      if (valid.includes(normalized)) {
        return { lifecycleState: normalized, supported: true };
      }

      return {
        lifecycleState: "no_status_change",
        supported: false,
        reason: `Unknown status label suffix '${suffix}' — cannot map to a normalized lifecycle state.`,
      };
    }

    return {
      lifecycleState: "no_status_change",
      supported: false,
      reason: `Unknown GitHub native status '${nativeStatus}'. Expected "open", "closed", or a "${this.labelPrefix}*" label.`,
    };
  }

  /**
   * Transitions a GitHub issue to a normalized lifecycle state.
   *
   * Steps performed:
   * 1. Fetches the current issue to discover existing `status:*` labels.
   * 2. Sets issue state to `"closed"` for `"done"` / `"cancelled"`, otherwise
   *    `"open"`.
   * 3. Removes all existing `status:*` labels from the issue.
   * 4. Adds a new `status:<lifecycle-state>` label (hyphens instead of
   *    underscores).
   *
   * Returns `{ applied: false, skipped: true }` when `lifecycleState` is
   * `"no_status_change"`.
   *
   * @param taskId - GitHub issue number as a string (e.g. `"42"`).
   * @param lifecycleState - Target normalized lifecycle state.
   * @param _evidence - Unused; accepted for interface compatibility.
   */
  async transitionLifecycleState(
    taskId: string,
    lifecycleState: NormalizedLifecycleState,
    _evidence?: Record<string, unknown>,
  ): Promise<LifecycleTransitionResult> {
    if (lifecycleState === "no_status_change") {
      return {
        applied: false,
        skipped: true,
        skipReason: "Lifecycle state is 'no_status_change', skipping transition.",
      };
    }

    const basePath = `/repos/${this.owner}/${this.repo}/issues/${taskId}`;

    try {
      // 1. Fetch current issue to find existing status labels
      const issue = await githubRequest<GitHubIssue>("GET", basePath, this.token);

      const existingStatusLabels = issue.labels
        .map((l) => l.name)
        .filter((name) => name.toLowerCase().startsWith(this.labelPrefixLower));

      // 2. Update open/closed state
      const newState =
        lifecycleState === "done" || lifecycleState === "cancelled" ? "closed" : "open";

      await githubRequest<GitHubIssue>("PATCH", basePath, this.token, { state: newState });

      // 3. Remove existing status:* labels
      for (const labelName of existingStatusLabels) {
        const encodedLabel = encodeURIComponent(labelName);
        await githubRequest<void>(
          "DELETE",
          `${basePath}/labels/${encodedLabel}`,
          this.token,
        );
      }

      // 4. Add new status label
      const newLabel = `${this.labelPrefix}${lifecycleStateToLabelSuffix(lifecycleState)}`;
      await githubRequest<GitHubLabel[]>("POST", `${basePath}/labels`, this.token, {
        labels: [newLabel],
      });

      return { applied: true, skipped: false };
    } catch (err) {
      return {
        applied: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Adds a comment to a GitHub issue.
   *
   * @param taskId - GitHub issue number as a string (e.g. `"42"`).
   * @param body - Markdown comment body.
   */
  async addComment(taskId: string, body: string): Promise<CommentResult> {
    const path = `/repos/${this.owner}/${this.repo}/issues/${taskId}/comments`;
    try {
      await githubRequest<unknown>("POST", path, this.token, { body });
      return { added: true, unsupported: false };
    } catch (err) {
      return {
        added: false,
        unsupported: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Link attachments are not supported by the GitHub Issues API.
   *
   * Always returns `{ attached: false, unsupported: true }`.
   *
   * @param _taskId - Unused.
   * @param _url - Unused.
   * @param _title - Unused.
   */
  async attachLink(_taskId: string, _url: string, _title?: string): Promise<LinkResult> {
    return {
      attached: false,
      unsupported: true,
      reason: "GitHub Issues does not support native link attachments.",
    };
  }

  /**
   * Dependency relations are not supported by the GitHub Issues API.
   *
   * Always returns `{ added: false, unsupported: true }`.
   *
   * @param _taskId - Unused.
   * @param _dependsOnTaskId - Unused.
   */
  async addDependency(_taskId: string, _dependsOnTaskId: string): Promise<DependencyResult> {
    return {
      added: false,
      unsupported: true,
      reason: "GitHub Issues does not support native dependency relations.",
    };
  }

  /**
   * Child issue creation is not supported by the GitHub Issues adapter.
   *
   * Always returns `{ created: false, unsupported: true }`.
   *
   * @param _parentId - Unused.
   * @param _title - Unused.
   * @param _body - Unused.
   */
  async createChild(
    _parentId: string,
    _title: string,
    _body?: string,
  ): Promise<CreateChildResult> {
    return {
      created: false,
      unsupported: true,
      reason: "GitHub Issues adapter does not support creating child issues.",
    };
  }
}
