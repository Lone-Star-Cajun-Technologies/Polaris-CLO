import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, sep } from "node:path";
import type {
  BootstrapPacket,
  DispatchOptions,
  DispatchResult,
  ExecutionAdapter,
} from "./types.js";
import type { ExecutionConfig, PaperclipExecutionConfig } from "../../config/schema.js";

export interface PaperclipRuntimeConfig extends PaperclipExecutionConfig {
  resolvedToken?: string;
}

export interface CreateIssuePayload {
  title: string;
  description: string;
  assigneeAgentId: string;
  status: "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  workMode: "standard" | "impl" | "validation" | "analysis";
  priority?: string;
  idempotencyKey?: string;
  labelIds?: never;
  parentId?: never;
}

export interface CreateIssueResult {
  id: string;
  companyId: string;
  title: string;
  status: string;
  workMode: string;
  priority?: string;
  assigneeAgentId: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaperclipStateRef {
  runId: string;
  issueId: string;
  companyId: string;
  baseUrl: string;
  updatedAt: string;
}

export interface RepoCoordinates {
  repoUrl: string;
  workingDirectory: string;
  targetPaths: string[];
}

/**
 * Build the <!-- POLARIS_COORDS --> block injected into every Paperclip issue
 * description. This is the authoritative serialization format for LSC-32.
 */
export function buildCoordsBlock(coords: RepoCoordinates): string {
  const payload = {
    repoUrl: coords.repoUrl,
    workingDirectory: coords.workingDirectory,
    targetPaths: coords.targetPaths,
  };
  return [
    "<!-- POLARIS_COORDS",
    JSON.stringify(payload, null, 2),
    "POLARIS_COORDS -->",
  ].join("\n");
}

/**
 * Resolve coordinates from packet and config, packet taking precedence.
 * Returns null when repoUrl or workingDirectory cannot be determined.
 */
export function resolveCoords(
  packet: BootstrapPacket,
  config: ExecutionConfig,
): RepoCoordinates | null {
  const pc = packet.repo_coordinates;
  const cfg = config.paperclip;

  const repoUrl = pc?.repoUrl ?? cfg?.repoUrl ?? "";
  const workingDirectory = pc?.workingDirectory ?? cfg?.workingDirectory ?? "";
  const targetPaths = pc?.targetPaths ?? cfg?.targetPaths ?? [];

  if (!repoUrl || !workingDirectory) {
    return null;
  }

  return { repoUrl, workingDirectory, targetPaths };
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const REDACTED = "<redacted>";

const TERMINAL_HTTP_CODES = new Set([
  400, 401, 403, 404, 405, 408, 410, 412, 413, 414, 415, 422, 428, 431,
]);

function classifyRetry(response: Response | null, error: unknown): string | null {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("econnreset") ||
      message.includes("enotfound") ||
      message.includes("eai_again") ||
      message.includes("network") ||
      message.includes("fetch failed") ||
      message.includes("socket hang up") ||
      message.includes("timeout") ||
      message.includes("ECONNREFUSED") ||
      message.includes("ECONNRESET") ||
      message.includes("ETIMEDOUT") ||
      message.includes("ENOTFOUND")
    ) {
      return "network";
    }
  }
  if (!response) return null;
  if (response.status === 429) return "429";
  if (response.status >= 500) return "5xx";
  return null;
}

function isTerminalStatus(status: number | undefined): boolean {
  if (typeof status !== "number") return true;
  return TERMINAL_HTTP_CODES.has(status);
}

export function resolvePaperclipRuntimeConfig(
  config: PaperclipExecutionConfig,
): PaperclipRuntimeConfig {
  const token = process.env[config.tokenEnv] ?? undefined;
  if (!token || token.trim() === "") {
    throw new Error(
      `Missing Paperclip bearer token in environment variable ${config.tokenEnv}`,
    );
  }
  return {
    ...config,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    resolvedToken: token.trim(),
  };
}

export function normalizePaperclipBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  return value.replace(/\/+$/, "");
}

function workerRoleFromPacket(packet: BootstrapPacket): string {
  const fromContext = (packet.context ?? {}) as { worker_role?: unknown; issue_context?: unknown };
  if (typeof fromContext.worker_role === "string" && fromContext.worker_role.trim() !== "") {
    return fromContext.worker_role.trim();
  }
  const v2 = packet as BootstrapPacket & {
    worker_role?: unknown;
    instructions?: { primary_goal?: string };
  };
  if (typeof v2.worker_role === "string" && v2.worker_role.trim() !== "") {
    return v2.worker_role.trim();
  }
  return "worker";
}

const ROLE_SKILL_ROUTING: Record<string, string> = {
  analyst: "polaris-analyze",
  worker: "polaris-run",
  impl: "polaris-run",
  finalize: "polaris-finalize",
};

function safeStr(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return fallback;
}

export function resolveAssigneeForRole(role: string, config: PaperclipRuntimeConfig): string {
  const direct = config.roleBindings?.[role];
  if (typeof direct === "string" && direct.trim() !== "") {
    return direct.trim();
  }
  const seen = new Set<string>();
  let current = role;
  while (true) {
    if (seen.has(current)) break;
    seen.add(current);
    const manager = config.reportsTo?.[current];
    if (typeof manager !== "string" || manager.trim() === "") break;
    const managerBinding = config.roleBindings?.[manager.trim()];
    if (typeof managerBinding === "string" && managerBinding.trim() !== "") {
      return managerBinding.trim();
    }
    current = manager.trim();
  }
  return config.assigneeAgentId;
}

/**
 * Validate that the assigned agent is not a foreman self-assigning to a child work slot.
 * Foremen must delegate to workers, not execute child work themselves.
 */
function validateChildAssignment(
  role: string,
  assigneeAgentId: string,
  config: PaperclipRuntimeConfig,
): { valid: boolean; error?: string } {
  // Only validate child/worker roles — foremen can be assigned to their own coordination tasks
  const childRoles = ["worker", "analyst", "repair"];
  if (!childRoles.includes(role)) {
    return { valid: true };
  }

  // Check if the assigned agent is a foreman
  const foremanAgents = config.roleRegistry?.foreman ?? [];
  if (foremanAgents.includes(assigneeAgentId)) {
    return {
      valid: false,
      error: `Foreman (agent ${assigneeAgentId.slice(0, 8)}…) cannot self-assign to a child work slot. ` +
             `Must delegate to a worker from the pool.`,
    };
  }

  return { valid: true };
}

export function mapBootstrapPacketToPaperclipIssue(
  packet: BootstrapPacket,
  config: PaperclipRuntimeConfig,
  dispatchId: string,
): CreateIssuePayload {
  const executionBlock = (packet.context?.execution as
    | { paperclip?: { assigneeAgentId?: string; priority?: unknown; runId?: string } }
    | undefined)?.paperclip;
  const role = workerRoleFromPacket(packet);
  const assigneeAgentId = executionBlock?.assigneeAgentId ?? resolveAssigneeForRole(role, config);

  // Validate foreman self-assignment
  const validation = validateChildAssignment(role, assigneeAgentId, config);
  if (!validation.valid) {
    throw new Error(`Child assignment validation failed: ${validation.error}`);
  }

  const rawPriority = executionBlock?.priority ?? "medium";
  const priorityText = typeof rawPriority === "string" ? rawPriority : String(rawPriority);
  const priority = safeStr(priorityText, "medium");

  const lines: string[] = [];
  lines.push(`Run ID: \`${packet.run_id}\``);
  lines.push(`Cluster ID: \`${packet.cluster_id}\``);
  lines.push(`Child/Active child: \`${packet.active_child}\``);
  lines.push(`Dispatch ID: \`${dispatchId}\``);
  lines.push(``);
  lines.push(`Worker role: \`${role}\``);
  lines.push(``);

  const polarisSkill = ROLE_SKILL_ROUTING[role];
  if (polarisSkill) {
    lines.push(`Polaris skill routing`);
    lines.push(`- \`${role}\` → \`${polarisSkill}\``);
    lines.push(``);
  }

  const instructionsPrimaryGoal = safeStr(
    ((packet as BootstrapPacket & { instructions?: { primary_goal?: string } }).instructions as
      | { primary_goal?: string }
      | undefined)?.primary_goal,
    "",
  );
  const descriptionFallback = instructionsPrimaryGoal || packet.active_child;
  lines.push(`Primary goal`);
  lines.push(descriptionFallback);
  lines.push(``);

  const steps =
    Array.isArray(
      ((packet as BootstrapPacket & { instructions?: { steps?: unknown[] } }).instructions as
        | { steps?: unknown[] }
        | undefined)?.steps,
    )
      ? ((packet as BootstrapPacket & { instructions?: { steps?: unknown[] } }).instructions as {
          steps?: unknown[];
        }).steps!
      : [];
  lines.push(`Ordered steps`);
  if (steps.length === 0) {
    lines.push("- No explicit steps provided.");
  } else {
    for (const step of steps) {
      lines.push(`- ${typeof step === "string" ? step : JSON.stringify(step)}`);
    }
  }

  lines.push(``);
  lines.push(`Allowed scope`);
  const allowedScope =
    Array.isArray(
      ((packet as BootstrapPacket & { instructions?: { allowed_scope?: string[] } }).instructions as
        | { allowed_scope?: string[] }
        | undefined)?.allowed_scope,
    )
      ? ((packet as BootstrapPacket & { instructions?: { allowed_scope?: string[] } }).instructions as {
          allowed_scope?: string[];
        }).allowed_scope!
      : [];
  if (allowedScope.length === 0) {
    lines.push("- No explicit allowed_scope provided.");
  } else {
    for (const item of allowedScope) {
      lines.push(`- \`${item}\``);
    }
  }
  lines.push(``);

  lines.push(`Validation commands`);
  const validationCommands =
    Array.isArray(
      ((packet as BootstrapPacket & { instructions?: { validation_commands?: string[] } }).instructions as
        | { validation_commands?: string[] }
        | undefined)?.validation_commands,
    )
      ? ((packet as BootstrapPacket & { instructions?: { validation_commands?: string[] } }).instructions as {
          validation_commands?: string[];
        }).validation_commands!
      : [];
  if (validationCommands.length === 0) {
    lines.push("- None provided.");
  } else {
    for (const command of validationCommands) {
      lines.push(`- \`${command}\``);
    }
  }
  lines.push(``);

  lines.push(`Sealed result`);
  lines.push(`- Path: \`${packet.state_file}\``);
  lines.push(`- Required fields: \`run_id\`, \`status\`, \`validation\`, \`next_recommended_action\``);
  lines.push(``);

  const description = lines.join("\n");
  // instructions.primary_goal and .steps are already rendered in full above
  // ("Primary goal" / "Ordered steps" sections) — omit them from the JSON
  // dump so the packet isn't duplicated twice in the same issue body.
  const rawInstructions = (packet as BootstrapPacket & { instructions?: Record<string, unknown> })
    .instructions;
  const compactInstructions = rawInstructions
    ? (() => {
        const { primary_goal, steps, ...rest } = rawInstructions;
        return rest;
      })()
    : undefined;
  const packetJsonDump = JSON.stringify(
    {
      schema_version: packet.schema_version,
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      active_child: packet.active_child,
      dispatch_id: packet.dispatch_id ?? null,
      worker_id: packet.worker_id ?? null,
      state_file: packet.state_file,
      telemetry_file: packet.telemetry_file,
      worker_role: workerRoleFromPacket(packet),
      instructions: compactInstructions,
      context: packet.context,
    },
    null,
    2,
  );
  const body = `${description}
\`\`\`json
POLARIS_PACKET_JSON
${packetJsonDump}
\`\`\``;
  // Postgres' issues_open_normalized_title_created_idx btree entry (company_id
  // + parent_id + normalized title + created_at) caps out at ~2704 bytes.
  // descriptionFallback can be the full multi-KB primary_goal text, so the
  // title needs its own short, capped value rather than reusing it verbatim.
  const MAX_TITLE_GOAL_LENGTH = 200;
  const titleGoal = descriptionFallback.split("\n")[0]!.trim() || packet.active_child;
  const truncatedTitleGoal =
    titleGoal.length > MAX_TITLE_GOAL_LENGTH ? `${titleGoal.slice(0, MAX_TITLE_GOAL_LENGTH - 1)}…` : titleGoal;
  return {
    title: `[${workerRoleFromPacket(packet)}] ${truncatedTitleGoal}`,
    description: body,
    assigneeAgentId,
    status: "todo",
    workMode: "standard",
    priority,
    idempotencyKey: `polaris:${packet.run_id}:${dispatchId}`,
  };
}

async function redactResolve(
  config: PaperclipRuntimeConfig,
  input: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    body?: unknown;
    runIdHeader?: string;
    idempotencyKey?: string;
  },
): Promise<{
    response: Response | null;
    body: Record<string, unknown> | null;
    status?: number;
    error?: string;
  }> {
  const baseUrl = normalizePaperclipBaseUrl(config.baseUrl);
  const url = `${baseUrl}${input.path.startsWith("/") ? input.path : `/${input.path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.resolvedToken}`,
    "Content-Type": "application/json",
  };
  if (input.runIdHeader) headers["X-Paperclip-Run-Id"] = input.runIdHeader;
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;

  const fetchOptions: RequestInit = {
    method: input.method,
    headers,
  };
  if (input.body !== undefined && input.method !== "GET") {
    fetchOptions.body = JSON.stringify(input.body);
  }

  let response: Response | null = null;
  try {
    response = await fetch(url, fetchOptions);
  } catch (error) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: string }).message)
        : String(error);
    return { response: null, body: null, error: message };
  }

  let body: Record<string, unknown> | null = null;
  const rawText = await response.text();
  if (rawText.trim().length > 0) {
    try {
      body = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      body = { _raw: rawText };
    }
  }

  return { response, body, status: response.status };
}

function readErrorDetail(body: Record<string, unknown> | null): string {
  if (!body) return "no-body";
  if (typeof body.error === "string" && body.error.trim().length > 0) return body.error.trim();
  if (typeof body.message === "string" && body.message.trim().length > 0)
    return body.message.trim();
  try {
    return JSON.stringify(body);
  } catch {
    return "malformed-body";
  }
}

function toCreateResult(
  body: Record<string, unknown> | null,
  fallback: CreateIssuePayload,
  issueId: string,
): CreateIssueResult {
  const safeRecord = (body ?? {}) as Record<string, unknown>;
  const field = (key: string) => safeRecord[key];
  return {
    id: issueId,
    companyId: safeStr(field("companyId"), ""),
    title: safeStr(field("title"), fallback.title),
    status: safeStr(field("status"), fallback.status),
    workMode: safeStr(field("workMode"), fallback.workMode),
    priority:
      typeof field("priority") === "string" ? safeStr(field("priority"), fallback.priority ?? "medium") : fallback.priority,
    assigneeAgentId: safeStr(field("assigneeAgentId"), fallback.assigneeAgentId),
    idempotencyKey: typeof field("idempotencyKey") === "string" ? safeStr(field("idempotencyKey"), "") : fallback.idempotencyKey,
    createdAt: safeStr(field("createdAt"), new Date().toISOString()),
    updatedAt: safeStr(field("updatedAt"), new Date().toISOString()),
  };
}

export async function paperclipRequest(
  config: PaperclipRuntimeConfig,
  input: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    body?: unknown;
    runIdHeader?: string;
    idempotencyKey?: string;
  },
): Promise<{
    response: Response | null;
    body: Record<string, unknown> | null;
    status?: number;
    error?: string;
    retry: string | null;
  }> {
  const result = await redactResolve(config, input);
  const retry = classifyRetry(result.response, result.error);
  return { ...result, retry };
}

export async function createPaperclipIssue(
  config: PaperclipRuntimeConfig,
  payload: CreateIssuePayload,
  runIdHeader: string,
  companyId: string,
): Promise<CreateIssueResult> {
  const key = payload.idempotencyKey ?? crypto.randomUUID();
  const path = `/api/companies/${companyId}/issues`;
  let lastRetry: string | null = null;
  let lastStatus: number | undefined;
  let lastBody: Record<string, unknown> | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const { response, body, error, status, retry } = await paperclipRequest(config, {
      method: "POST",
      path,
      body: { ...payload, idempotencyKey: key },
      runIdHeader,
      idempotencyKey: key,
    });

    lastRetry = retry;
    lastStatus = status;
    lastBody = body;

    if (error) {
      if (retry && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
        continue;
      }
      throw new Error(
        `Paperclip create issue failed: HTTP=${status ?? "unknown"} path=${path} issue_id=unknown retry=${retry ?? "none"} detail=${redact(String(error))}`,
      );
    }

    if (typeof status === "number" && isTerminalStatus(status)) {
      throw new Error(
        `Paperclip create issue failed: HTTP=${status} path=${path} issue_id=unknown retry=none detail=${redact(readErrorDetail(body))}`,
      );
    }

    const plainBody = body ?? {};
    const idCandidate =
      (plainBody as any).id ??
      (plainBody as any).data?.id ??
      (plainBody as any).issue?.id ??
      (plainBody as any)[':id'] ??
      (plainBody as any)._id;
    const issueId = typeof idCandidate === "string" ? idCandidate.trim() : null;
    if (!issueId) {
      const retryCandidate = classifyRetry(response, null);
      if (retryCandidate && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
        continue;
      }
      throw new Error(`Paperclip create issue returned empty issue id. HTTP=${status}`);
    }

    return toCreateResult(plainBody as Record<string, unknown>, payload, issueId);
  }

  throw new Error(
    `Paperclip create issue failed: HTTP=${lastStatus ?? "unknown"} path=${path} issue_id=unknown retry=${lastRetry ?? "exhausted"} detail=${redact(readErrorDetail(lastBody))}`,
  );
}

export async function getPaperclipIssue(
  config: PaperclipRuntimeConfig,
  companyId: string,
  issueId: string,
  runIdHeader = "",
): Promise<{ issue: PaperclipIssue; status: { http: number; retry: string | null } }> {
  let lastRetry: string | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { response, body, error, status, retry } = await paperclipRequest(
      config,
      {
        method: "GET",
        path: `/api/companies/${companyId}/issues/${issueId}`,
        runIdHeader: runIdHeader || undefined,
      },
    );
    lastRetry = retry ?? "terminal";

    if (error) {
      if (lastRetry && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
        continue;
      }
      throw new Error(
        `Paperclip get issue failed: HTTP=${status ?? "unknown"} path=/api/companies/${companyId}/issues/${issueId} issue_id=${issueId} retry=${lastRetry} detail=${redact(String(error))}`,
      );
    }

    if (typeof status === "number" && isTerminalStatus(status)) {
      throw new Error(
        `Paperclip get issue failed: HTTP=${status} path=/api/companies/${companyId}/issues/${issueId} issue_id=${issueId} retry=none detail=${redact(readErrorDetail(body ?? null))}`,
      );
    }

    return { issue: (body ?? {}) as PaperclipIssue, status: { http: status ?? 200, retry: null } };
  }

  throw new Error(
    `Paperclip get issue failed: HTTP=unknown path=/api/companies/${companyId}/issues/${issueId} issue_id=${issueId} retry=${lastRetry} detail=no-detail`,
  );
}

export function mergePaperclipRefIntoState(
  state: Record<string, unknown>,
  ref: PaperclipStateRef,
  result: { status: string; message?: string },
): Record<string, unknown> {
  return {
    ...state,
    paperclip: { ...(state.paperclip as Record<string, unknown> | undefined), ...ref },
    result: { ...result },
  };
}

export interface PaperclipIssue extends Record<string, unknown> {
  status?: string;
  attachments?: unknown[];
  pullRequest?: unknown;
  pullRequests?: unknown[];
  commit?: unknown;
  commits?: unknown[];
  branch?: unknown;
  branches?: unknown[];
  workProduct?: unknown;
  workProducts?: unknown[];
  work_product?: unknown;
  work_products?: unknown[];
  linkedPullRequests?: unknown[];
  linkedCommits?: unknown[];
  linkedBranches?: unknown[];
}

const WORK_PRODUCT_EVIDENCE_KEYS = [
  "pullRequest",
  "pullRequests",
  "commit",
  "commits",
  "branch",
  "branches",
  "attachment",
  "attachments",
  "workProduct",
  "workProducts",
  "work_product",
  "work_products",
  "linkedPullRequests",
  "linkedCommits",
  "linkedBranches",
];

function isNonEmptyEvidence(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0 && value.some((v) => isNonEmptyEvidence(v));
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

export function hasWorkProductEvidence(issue: PaperclipIssue): { hasEvidence: boolean; evidenceFields: string[] } {
  const evidenceFields: string[] = [];
  for (const key of WORK_PRODUCT_EVIDENCE_KEYS) {
    if (key in issue && isNonEmptyEvidence(issue[key])) {
      evidenceFields.push(key);
    }
  }
  return { hasEvidence: evidenceFields.length > 0, evidenceFields };
}

/**
 * Validate that the issue has a valid successfulRunHandoff disposition.
 * Returns { valid: true } if handoff is properly settled, or { valid: false, message } if not.
 */
function validateSuccessfulRunHandoff(issue: PaperclipIssue): { valid: boolean; message?: string } {
  const handoff = (issue as Record<string, unknown>).successfulRunHandoff as
    | { state?: string; correctiveRunId?: string | null; hasLiveContinuation?: boolean }
    | null
    | undefined;

  // No handoff record: the issue didn't establish a disposition
  if (!handoff) {
    return {
      valid: false,
      message: "No successfulRunHandoff disposition record found. Issue must establish a valid disposition (resolved/escalated with continuation) before completing.",
    };
  }

  const state = typeof handoff.state === "string" ? handoff.state : null;

  // Resolved state: valid completion
  if (state === "resolved") {
    return { valid: true };
  }

  // Escalated state: must have either a corrective run or live continuation
  if (state === "escalated") {
    const hasCorrectiveRun = typeof handoff.correctiveRunId === "string" && handoff.correctiveRunId.trim().length > 0;
    const hasLiveContinuation = handoff.hasLiveContinuation === true;

    if (hasCorrectiveRun || hasLiveContinuation) {
      return { valid: true };
    }

    return {
      valid: false,
      message: "Issue escalated but no corrective run or live continuation path is set. Escalation requires a clear path forward.",
    };
  }

  // Required state: not yet settled
  if (state === "required") {
    return {
      valid: false,
      message: "Issue did not resolve the successfulRunHandoff requirement. Must complete a valid disposition (resolved or escalated with continuation).",
    };
  }

  return {
    valid: false,
    message: `Unknown successfulRunHandoff state: "${state}". Expected one of: resolved, escalated, required.`,
  };
}

export async function waitForPaperclipExecution(
  config: PaperclipRuntimeConfig,
  companyId: string,
  issueId: string,
  runIdHeader: string,
  runId: string,
): Promise<PaperclipStateRef> {
  const startedAt = Date.now();
  const pollMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let ref = refFrom(issueId, companyId, runId, config.baseUrl);

  while (Date.now() - startedAt < timeoutMs) {
    const { issue } = await getPaperclipIssue(config, companyId, issueId, runIdHeader);
    const statusValue = typeof issue.status === "string" ? issue.status.trim().toLowerCase() : null;
    if (
      statusValue === "done" ||
      statusValue === "cancelled" ||
      statusValue === "failed" ||
      statusValue === "blocked"
    ) {
      ref = { ...ref, updatedAt: new Date().toISOString() };
      return ref;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return ref;
}

function refFrom(issueId: string, companyId: string, runId: string, baseUrl: string) {
  return {
    runId,
    issueId,
    companyId,
    baseUrl,
    updatedAt: new Date().toISOString(),
  } as PaperclipStateRef;
}

export class PaperclipAdapter implements ExecutionAdapter {
  readonly name = "paperclip";

  constructor(private readonly runtimeConfig: PaperclipRuntimeConfig) {}

  async dispatch(
    packet: BootstrapPacket,
    options: DispatchOptions,
  ): Promise<DispatchResult> {
    const runId = safeStr(
      (packet as BootstrapPacket & { run_id?: string }).run_id,
      "",
    );
    const primaryProvider = options.provider || "paperclip";
    const providerAttempts: NonNullable<DispatchResult["provider_attempts"]> = [];
    const dispatchId = crypto.randomUUID();
    const runIdHeader =
      ((packet.context?.execution as
        | { paperclip?: { runId?: string } }
        | undefined)?.paperclip?.runId ?? "");

    if (this.runtimeConfig.resolvedToken === undefined) {
      const message = `Paperclip precondition failed: bearer token missing in env ${this.runtimeConfig.tokenEnv}`;
      providerAttempts.push({
        provider: primaryProvider,
        failure_origin: "provider-launch",
        failure_category: "provider-unavailable",
        pre_dispatch_failure: true,
        fallback_eligible: false,
        message,
      });
      return {
        exit_code: 2,
        provider_used: primaryProvider,
        command_run: `paperclip:${packet.active_child || "worker"}`,
        summary: JSON.stringify({ child_id: packet.active_child, status: "error", message }),
        stderr: message,
        pre_dispatch_failure: true,
        failure_origin: "provider-launch",
        failure_category: "provider-unavailable",
        fallback_eligible: false,
        router_evidence: options.routerDecision,
        provider_attempts: JSON.parse(JSON.stringify(providerAttempts)) as NonNullable<DispatchResult["provider_attempts"]>,
      };
    }

    try {
      const payload = mapBootstrapPacketToPaperclipIssue(
        packet,
        this.runtimeConfig,
        dispatchId,
      );
      const created = await createPaperclipIssue(
        this.runtimeConfig,
        payload,
        runIdHeader,
        this.runtimeConfig.companyId,
      );

      const ref = await waitForPaperclipExecution(
        this.runtimeConfig,
        this.runtimeConfig.companyId,
        created.id,
        runIdHeader,
        runId,
      );

      const { issue: finalIssue } = await getPaperclipIssue(
        this.runtimeConfig,
        this.runtimeConfig.companyId,
        created.id,
        runIdHeader,
      );
      const resultFile = (packet as unknown as { result_file_contract?: { result_file?: string } }).result_file_contract?.result_file;
      const sealedResult = finalIssue["result"];
      if (
        resultFile &&
        typeof sealedResult === "object" &&
        sealedResult !== null &&
        !Array.isArray(sealedResult)
      ) {
        mkdirSync(dirname(resultFile), { recursive: true });
        writeFileSync(resultFile, JSON.stringify(sealedResult, null, 2), "utf-8");
      }
      const finalStatus = typeof finalIssue.status === "string" ? finalIssue.status.trim().toLowerCase() : null;
      if (finalStatus === "done") {
        // Validate work-product evidence
        const evidence = hasWorkProductEvidence(finalIssue);
        if (!evidence.hasEvidence) {
          const message = `Paperclip issue ${created.id} reported status "done" but no verifiable work-product evidence (PR/commit/branch/attachment) was present in the issue response.`;
          providerAttempts.push({
            provider: primaryProvider,
            failure_origin: "worker-execution",
            failure_category: "worker-failure",
            pre_dispatch_failure: false,
            fallback_eligible: false,
            message,
          });
          return {
            exit_code: 2,
            provider_used: primaryProvider,
            command_run: `paperclip:${packet.active_child || "worker"}`,
            summary: JSON.stringify({
              child_id: packet.active_child,
              status: "failed",
              provider_used: primaryProvider,
              issue_id: created.id,
              company_id: this.runtimeConfig.companyId,
              dispatch_id: dispatchId,
              run_id: runId,
              message,
            }),
            stderr: message,
            pre_dispatch_failure: false,
            failure_origin: "worker-execution",
            failure_category: "worker-failure",
            fallback_eligible: false,
            router_evidence: options.routerDecision,
            provider_attempts: JSON.parse(JSON.stringify(providerAttempts)) as NonNullable<DispatchResult["provider_attempts"]>,
          };
        }

        // Validate successfulRunHandoff disposition
        const handoffValidation = validateSuccessfulRunHandoff(finalIssue);
        if (!handoffValidation.valid) {
          const message = `Paperclip issue ${created.id} completed but handoff disposition is invalid: ${handoffValidation.message}`;
          providerAttempts.push({
            provider: primaryProvider,
            failure_origin: "worker-execution",
            failure_category: "worker-failure",
            pre_dispatch_failure: false,
            fallback_eligible: false,
            message,
          });
          return {
            exit_code: 2,
            provider_used: primaryProvider,
            command_run: `paperclip:${packet.active_child || "worker"}`,
            summary: JSON.stringify({
              child_id: packet.active_child,
              status: "failed",
              provider_used: primaryProvider,
              issue_id: created.id,
              company_id: this.runtimeConfig.companyId,
              dispatch_id: dispatchId,
              run_id: runId,
              message,
            }),
            stderr: message,
            pre_dispatch_failure: false,
            failure_origin: "worker-execution",
            failure_category: "worker-failure",
            fallback_eligible: false,
            router_evidence: options.routerDecision,
            provider_attempts: JSON.parse(JSON.stringify(providerAttempts)) as NonNullable<DispatchResult["provider_attempts"]>,
          };
        }
      }

      return {
        exit_code: 0,
        provider_used: primaryProvider,
        command_run: `paperclip:${packet.active_child || "worker"}`,
        summary: JSON.stringify({
          child_id: packet.active_child,
          status: "done",
          provider_used: primaryProvider,
          issue_id: created.id,
          company_id: this.runtimeConfig.companyId,
          dispatch_id: dispatchId,
          run_id: runId,
          message: "Paperclip execution completed.",
        }),
        pre_dispatch_failure: false,
        router_evidence: options.routerDecision,
        provider_attempts: providerAttempts,
      };
    } catch (error) {
      const message =
        typeof error === "object" &&
        error !== null &&
        "message" in (error as Record<string, unknown>)
          ? String((error as Record<string, unknown>).message)
          : JSON.stringify(error);
      providerAttempts.push({
        provider: primaryProvider,
        failure_origin: "worker-execution",
        failure_category: "worker-failure",
        pre_dispatch_failure: true,
        fallback_eligible: false,
        message,
      });
      return {
        exit_code: 2,
        provider_used: primaryProvider,
        command_run: `paperclip:${packet.active_child || "worker"}`,
        summary: JSON.stringify({ child_id: packet.active_child, status: "error", message }),
        stderr: message,
        pre_dispatch_failure: true,
        failure_origin: "worker-execution",
        failure_category: "worker-failure",
        fallback_eligible: false,
        router_evidence: options.routerDecision,
        provider_attempts: JSON.parse(JSON.stringify(providerAttempts)) as NonNullable<DispatchResult["provider_attempts"]>,
      };
    }
  }
}

function redact(text: string): string {
  const candidates = [
    /bearer\s+[^\s",;}\]]+/gi,
    /"(?:authorization|token|api[_-]?key|secret|password)"?\s*:\s*"(?:[^"\\{,;}\]]*)"/gi,
    /'(?:authorization|token|api[_-]?key|secret|password)'?\s*:\s*'(?:[^'\\,;}\]]*)'/gi,
    /"(?:authorization|token|api[_-]?key|secret|password)"?\s*:\s*'(?:[^'\\,;}\]]*)'/gi,
  ];
  let out = text;
  for (const pattern of candidates) out = out.replace(pattern, REDACTED);
  return out;
}
