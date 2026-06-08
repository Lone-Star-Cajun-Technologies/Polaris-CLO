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

/**
 * Configuration for the Jira Cloud adapter.
 */
export interface JiraAdapterConfig {
  /** Base URL of the Jira Cloud instance, e.g. "https://your-domain.atlassian.net". */
  baseUrl: string;
  /** Atlassian account email used for Basic Auth. */
  email: string;
  /** Jira API token used for Basic Auth. */
  apiToken: string;
  /** Jira project key, e.g. "POL". */
  projectKey: string;
  /**
   * Optional overrides mapping native Jira status names (case-insensitive) to
   * normalized lifecycle states. Takes precedence over the built-in heuristic.
   */
  statusMappings?: Record<string, NormalizedLifecycleState>;
}

/** Shape of a Jira transition object returned by the transitions endpoint. */
interface JiraTransition {
  id: string;
  name: string;
}

/** Response body from GET /rest/api/3/issue/{taskId}/transitions. */
interface JiraTransitionsResponse {
  transitions: JiraTransition[];
}

const JIRA_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Performs an HTTPS request against the Jira Cloud REST API v3.
 *
 * @param config - Adapter config providing baseUrl and credentials.
 * @param method - HTTP method ("GET" or "POST").
 * @param path - API path, e.g. "/rest/api/3/issue/FOO-1/transitions".
 * @param body - Optional request body. Will be JSON-serialized when provided.
 * @returns Parsed JSON response body.
 * @throws On HTTP 4xx/5xx or JSON parse failure.
 */
function jiraRequest(
  config: JiraAdapterConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  const url = new URL(config.baseUrl);
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  return new Promise<unknown>((resolve, reject) => {
    const options: import("https").RequestOptions = {
      hostname: url.hostname,
      port: url.port || undefined,
      path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        ...(payload !== undefined
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {}),
      },
    };

    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf-8");
        if ((res.statusCode ?? 0) >= 400) {
          reject(
            new Error(
              `Jira API returned ${res.statusCode}: ${responseBody || "<empty response body>"}`,
            ),
          );
          return;
        }
        if (!responseBody) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          reject(new Error(`Jira API returned non-JSON response: ${responseBody}`));
        }
      });
    });

    req.setTimeout(JIRA_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Jira API request timed out after ${JIRA_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Heuristic mapping from lowercased Jira status names to normalized lifecycle states.
 * Returns `undefined` when no match is found.
 */
function heuristicMap(normalizedName: string): NormalizedLifecycleState | undefined {
  if (["to do", "backlog", "new", "open"].includes(normalizedName)) {
    return "backlog";
  }
  if (["in progress", "in development", "started", "doing"].includes(normalizedName)) {
    return "in_progress";
  }
  if (["in review", "under review", "ready for review", "in qa", "in testing"].includes(normalizedName)) {
    return "in_review";
  }
  if (["done", "completed", "resolved", "closed", "ready for deployment"].includes(normalizedName)) {
    return "done";
  }
  if (["blocked", "on hold", "waiting", "paused"].includes(normalizedName)) {
    return "blocked";
  }
  if (["cancelled", "canceled", "won't do", "duplicate", "invalid"].includes(normalizedName)) {
    return "cancelled";
  }
  return undefined;
}

/**
 * Tracker adapter for Jira Cloud using the REST API v3 with Basic Auth.
 *
 * Implements `CapableTrackerAdapter` to provide lifecycle state transitions,
 * comment posting, and status mapping against a Jira Cloud project.
 */
export class JiraCloudAdapter implements CapableTrackerAdapter {
  private readonly config: JiraAdapterConfig;

  /**
   * Creates a new JiraCloudAdapter.
   *
   * @param config - Jira Cloud connection and project configuration.
   */
  constructor(config: JiraAdapterConfig) {
    this.config = config;
  }

  /**
   * Returns the capabilities supported by the Jira Cloud adapter.
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
   * Maps a Jira status name to a normalized lifecycle state, consulting
   * user-configured `statusMappings` before falling back to the built-in
   * heuristic.
   *
   * @param statusName - The native Jira status name (case-insensitive).
   * @returns The matching normalized lifecycle state, or `undefined` if unknown.
   */
  private mapStatusToLifecycle(statusName: string): NormalizedLifecycleState | undefined {
    const normalizedName = statusName.toLowerCase().trim();

    if (this.config.statusMappings) {
      for (const [key, value] of Object.entries(this.config.statusMappings)) {
        if (key.toLowerCase().trim() === normalizedName) {
          return value;
        }
      }
    }

    return heuristicMap(normalizedName);
  }

  /**
   * Maps a native Jira status name to a normalized lifecycle state.
   *
   * User-provided `statusMappings` in the adapter config override the built-in
   * heuristic for any matching status name (case-insensitive).
   *
   * @param nativeStatus - The native Jira status name (e.g. "In Progress").
   * @returns A status mapping result with the normalized state and support status.
   */
  mapNativeStatus(nativeStatus: string): StatusMappingResult {
    const mapped = this.mapStatusToLifecycle(nativeStatus);

    if (mapped !== undefined) {
      return { lifecycleState: mapped, supported: true };
    }

    return {
      lifecycleState: "no_status_change",
      supported: false,
      reason: `Unknown Jira status '${nativeStatus}'. Consider adding an explicit statusMappings override.`,
    };
  }

  /**
   * Attempts to transition a Jira issue to the target lifecycle state.
   *
   * Fetches available transitions from the Jira API, finds one whose name
   * heuristically maps to the requested lifecycle state, and applies it.
   *
   * @param taskId - The Jira issue key or ID (e.g. "POL-42").
   * @param lifecycleState - The target normalized lifecycle state.
   * @param _evidence - Unused. Present for interface compatibility.
   * @returns A lifecycle transition result indicating success, skip, or failure.
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
        skipReason: "Lifecycle state is 'no_status_change', skipping transition",
      };
    }

    let transitionsData: JiraTransitionsResponse;
    try {
      transitionsData = (await jiraRequest(
        this.config,
        "GET",
        `/rest/api/3/issue/${taskId}/transitions`,
      )) as JiraTransitionsResponse;
    } catch (err) {
      return {
        applied: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const transitions = transitionsData?.transitions ?? [];

    // Find a transition whose name maps to the target lifecycle state (respects statusMappings).
    const match = transitions.find((t) => this.mapStatusToLifecycle(t.name) === lifecycleState);

    if (!match) {
      return {
        applied: false,
        skipped: true,
        skipReason: `No Jira transition found that maps to lifecycle state '${lifecycleState}' for issue '${taskId}'.`,
      };
    }

    try {
      await jiraRequest(this.config, "POST", `/rest/api/3/issue/${taskId}/transitions`, {
        transition: { id: match.id },
      });
    } catch (err) {
      return {
        applied: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return { applied: true, skipped: false };
  }

  /**
   * Adds a comment to a Jira issue using the Atlassian Document Format (ADF).
   *
   * @param taskId - The Jira issue key or ID (e.g. "POL-42").
   * @param body - The plain-text comment body.
   * @returns A comment result indicating success or failure.
   */
  async addComment(taskId: string, body: string): Promise<CommentResult> {
    const adfBody = {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: body }],
          },
        ],
      },
    };

    try {
      await jiraRequest(this.config, "POST", `/rest/api/3/issue/${taskId}/comment`, adfBody);
    } catch (err) {
      return {
        added: false,
        unsupported: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return { added: true, unsupported: false };
  }

  /**
   * Attaching arbitrary URL links is not supported by this adapter.
   *
   * Jira has issue links but not arbitrary URL attachments. Use `addComment`
   * to include URLs in issue comments instead.
   *
   * @param _taskId - Unused.
   * @param _url - Unused.
   * @param _title - Unused.
   * @returns A link result indicating the operation is unsupported.
   */
  async attachLink(_taskId: string, _url: string, _title?: string): Promise<LinkResult> {
    return {
      attached: false,
      unsupported: true,
      reason:
        "Jira Cloud adapter does not support arbitrary URL link attachments. Use addComment to include URLs.",
    };
  }

  /**
   * Dependency relations are not supported by this adapter.
   *
   * @param _taskId - Unused.
   * @param _dependsOnTaskId - Unused.
   * @returns A dependency result indicating the operation is unsupported.
   */
  async addDependency(_taskId: string, _dependsOnTaskId: string): Promise<DependencyResult> {
    return {
      added: false,
      unsupported: true,
      reason: "Jira Cloud adapter does not support dependency relations via this interface.",
    };
  }

  /**
   * Creating child tasks is not supported by this adapter.
   *
   * @param _parentId - Unused.
   * @param _title - Unused.
   * @param _body - Unused.
   * @returns A create child result indicating the operation is unsupported.
   */
  async createChild(_parentId: string, _title: string, _body?: string): Promise<CreateChildResult> {
    return {
      created: false,
      unsupported: true,
      reason: "Jira Cloud adapter does not support creating child issues via this interface.",
    };
  }
}
