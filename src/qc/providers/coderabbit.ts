import type {
  IQcProvider,
  QcMetricsPayload,
  QcProviderOutput,
  QcReviewScope,
} from "../provider.js";
import type { QcAttribution, QcFailureReason, QcFinding, QcResult, QcSeverity } from "../types.js";
import { maxSeverity, normalizeSeverity } from "../severity.js";
import type { QcProviderConfig } from "../../config/schema.js";

/**
 * Loose shape for CodeRabbit-style review output. We parse defensively because
 * provider formats vary across CLI versions and agent payloads.
 */
interface CodeRabbitFindingLike {
  severity?: string;
  level?: string;
  file?: string;
  filePath?: string;
  path?: string;
  fileName?: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  column?: number;
  startColumn?: number;
  endColumn?: number;
  title?: string;
  summary?: string;
  message?: string;
  description?: string;
  body?: string;
  category?: string;
  type?: string;
  rule?: string;
  suggestion?: string;
  suggestedAction?: string;
  fix?: string;
  codegenInstructions?: string;
  suggestions?: string[];
  fixAvailable?: boolean;
  autofixEligible?: boolean;
  providerFindingId?: string;
  id?: string;
  findingId?: string;
  confidence?: number;
}

interface CodeRabbitReportLike {
  findings?: CodeRabbitFindingLike[];
  summary?: {
    total?: number;
    issues?: number;
    blockers?: number;
  };
  provider?: string;
  prUrl?: string;
}

function coerceNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function pickString(...candidates: (unknown | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

const FINDING_LOCATION_KEYS = ["file", "filePath", "path", "fileName"];
const FINDING_CONTENT_KEYS = [
  "message",
  "title",
  "summary",
  "description",
  "body",
  "suggestion",
  "suggestedAction",
  "fix",
  "codegenInstructions",
];
const FINDING_BOOKKEEPING_KEYS = [
  "severity",
  "category",
  "rule",
  "providerFindingId",
  "id",
  "findingId",
];
const PROGRESS_SHAPE_KEYS = new Set(["event", "progress", "heartbeat", "complete", "review_context"]);
const ERROR_TYPE_RATE_LIMIT = new Set(["rate_limit", "rate-limit", "ratelimit", "rate limit"]);
const ERROR_TYPE_AUTH = new Set(["auth", "authentication", "unauthorized", "unauthorised", "forbidden"]);
const PROGRESS_TYPE_VALUES = new Set([
  "progress",
  "status",
  "heartbeat",
  "complete",
  "review_context",
  "reviewcontext",
]);
const PROGRESS_STATUS_VALUES = new Set([
  "in_progress",
  "running",
  "pending",
  "complete",
  "completed",
  "done",
  "heartbeat",
  "ok",
  "success",
]);
const TERMINAL_COMPLETE_STATUSES = new Set([
  "review_completed",
  "review_skipped",
  "completed",
  "complete",
  "done",
  "success",
]);

function hasFindingLocation(record: Record<string, unknown>): boolean {
  return FINDING_LOCATION_KEYS.some((key) => record[key] !== undefined);
}

function isGenuineTitle(record: Record<string, unknown>): boolean {
  const title = record.title;
  if (typeof title !== "string" || title.trim().length === 0) {
    return false;
  }
  const trimmedTitle = title.trim().toLowerCase();
  const fallbackSources = [record.category, record.type, record.rule];
  for (const source of fallbackSources) {
    if (typeof source === "string" && source.trim().toLowerCase() === trimmedTitle) {
      return false;
    }
  }
  return true;
}

function hasFindingContent(record: Record<string, unknown>): boolean {
  for (const key of FINDING_CONTENT_KEYS) {
    if (key === "title") {
      if (isGenuineTitle(record)) return true;
    } else if (record[key] !== undefined) {
      return true;
    }
  }
  return false;
}

function hasFindingBookkeeping(record: Record<string, unknown>): boolean {
  return FINDING_BOOKKEEPING_KEYS.some((key) => record[key] !== undefined);
}

function hasFindingShape(record: Record<string, unknown>): boolean {
  return hasFindingLocation(record) || hasFindingContent(record) || hasFindingBookkeeping(record);
}

function isProgressRecord(record: Record<string, unknown>): boolean {
  // Check progress/status indicators FIRST before the generic finding-content guard
  const keys = Object.keys(record);
  if (keys.length === 0) return false;
  if (keys.some((key) => PROGRESS_SHAPE_KEYS.has(key))) return true;
  if (typeof record.type === "string" && PROGRESS_TYPE_VALUES.has(record.type.toLowerCase())) return true;
  if (typeof record.status === "string" && PROGRESS_STATUS_VALUES.has(record.status.toLowerCase())) return true;

  // Status-only records with category="status" are progress records even if they have message/title fields
  if (typeof record.category === "string" && record.category.toLowerCase() === "status") return true;

  // Only reject as progress if it has both location AND content (true finding shape)
  if (hasFindingLocation(record) && hasFindingContent(record)) {
    return false;
  }

  return false;
}

function isActionableFinding(record: Record<string, unknown>): boolean {
  if (isErrorRecord(record)) return false;
  if (isProgressRecord(record)) return false;
  return hasFindingLocation(record) || hasFindingContent(record);
}

function isUnusableFindingRecord(record: Record<string, unknown>): boolean {
  return !isActionableFinding(record) && (isProgressRecord(record) || hasFindingShape(record));
}

function makeUnusableOutputError(message: string): Error {
  const err = new Error(message);
  (err as { qcFailureReason?: QcFailureReason }).qcFailureReason = "unusable-output";
  return err;
}

function makeQcFailureError(reason: QcFailureReason, message: string): Error {
  const err = new Error(message);
  (err as { qcFailureReason?: QcFailureReason }).qcFailureReason = reason;
  return err;
}

function isErrorRecord(record: Record<string, unknown>): boolean {
  if (record.type === "error") return true;
  if (typeof record.errorType === "string") return true;
  if (record.error === true || record.error === "true") return true;
  if (typeof record.status === "string" && record.status.toLowerCase() === "error") return true;
  return false;
}

function errorTypeFromRecord(record: Record<string, unknown>): string | undefined {
  const fromType = typeof record.errorType === "string" ? record.errorType : undefined;
  const fromMessage = typeof record.message === "string" ? record.message : undefined;
  return fromType ?? fromMessage;
}

function classifyErrorType(record: Record<string, unknown>): QcFailureReason {
  const raw = errorTypeFromRecord(record);
  const errorType = (raw ?? "").toString().toLowerCase().trim();
  if (errorType === "") return "unavailable-provider";
  if (ERROR_TYPE_RATE_LIMIT.has(errorType)) return "rate-limited";
  if (ERROR_TYPE_AUTH.has(errorType)) return "auth-failure";
  if (errorType.includes("rate limit")) return "rate-limited";
  if (errorType.includes("auth")) return "auth-failure";
  if (errorType.includes("unauthorized")) return "auth-failure";
  if (errorType.includes("forbidden")) return "auth-failure";
  if (["timeout", "timed out"].includes(errorType)) return "timeout";
  if (errorType.includes("not found") || errorType.includes("not_found")) return "command-not-found";
  if (errorType.includes("unavailable") || errorType.includes("api_error") || errorType.includes("apierror") || errorType.includes("server") || errorType.includes("network") || errorType.includes("connection") || errorType.includes("internal")) {
    return "unavailable-provider";
  }
  return "unavailable-provider";
}

function getTerminalCompleteFindingsCount(record: Record<string, unknown>): number | undefined {
  if (record.findings !== undefined) {
    if (Array.isArray(record.findings)) {
      return record.findings.length;
    }
    const count = typeof record.findings === "number" ? record.findings : Number(record.findings);
    if (Number.isFinite(count)) return count;
  }
  const summary = record.summary;
  if (summary && typeof summary === "object") {
    const summaryRecord = summary as Record<string, unknown>;
    if (summaryRecord.total !== undefined) {
      const count = Number(summaryRecord.total);
      if (Number.isFinite(count)) return count;
    }
    if (summaryRecord.issues !== undefined) {
      const count = Number(summaryRecord.issues);
      if (Number.isFinite(count)) return count;
    }
  }
  return undefined;
}

function isTerminalCompleteNoFindings(record: Record<string, unknown>): boolean {
  if (record.type !== "complete") return false;
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  if (!TERMINAL_COMPLETE_STATUSES.has(status)) return false;
  const count = getTerminalCompleteFindingsCount(record);
  return count === undefined || count === 0;
}

function buildRange(raw: CodeRabbitFindingLike) {
  const startLine = coerceNumber(raw.startLine ?? raw.line) ?? 1;
  const endLine = coerceNumber(raw.endLine);
  const startColumn = coerceNumber(raw.startColumn ?? raw.column);
  const endColumn = coerceNumber(raw.endColumn);

  if (!endLine && startColumn === undefined && endColumn === undefined) {
    return { startLine };
  }

  return {
    startLine,
    ...(startColumn !== undefined ? { startColumn } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(endColumn !== undefined ? { endColumn } : {}),
  };
}

function parseFindingsFromPayload(payload: unknown): CodeRabbitFindingLike[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;

  if (isErrorRecord(record)) {
    throw makeQcFailureError(
      classifyErrorType(record),
      `CodeRabbit provider returned an error: ${record.message ?? record.errorType ?? "unknown"}`,
    );
  }

  const arrays = [record.findings, record.issues, record.results];
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      const findings: CodeRabbitFindingLike[] = [];
      for (const item of arr as unknown[]) {
        if (typeof item !== "object" || item === null) {
          continue;
        }
        const itemRecord = item as Record<string, unknown>;
        if (isErrorRecord(itemRecord)) {
          throw makeQcFailureError(
            classifyErrorType(itemRecord),
            `CodeRabbit provider returned an error in findings array: ${itemRecord.message ?? itemRecord.errorType ?? "unknown"}`,
          );
        }
        if (isActionableFinding(itemRecord)) {
          findings.push(item as CodeRabbitFindingLike);
        }
      }
      return findings;
    }
  }

  // Single finding wrapped in an object
  if (isActionableFinding(record)) {
    return [record as CodeRabbitFindingLike];
  }

  return [];
}

function parseReport(
  output: QcProviderOutput | QcMetricsPayload,
  format?: "json" | "jsonl" | "sarif" | "generic",
  parser?: string,
): CodeRabbitReportLike | null {
  if (parser && parser !== "coderabbit") {
    throw new Error(`Unsupported parser for CodeRabbit provider: ${parser}`);
  }

  if (format === "sarif") {
    throw new Error("SARIF output format is not supported by the CodeRabbit provider");
  }

  const text = "stdout" in output && typeof output.stdout === "string" ? output.stdout : "";
  const data = "data" in output ? output.data : undefined;

  if (data !== undefined && typeof data === "object" && data !== null) {
    const findings = parseFindingsFromPayload(data);
    const record = data as Record<string, unknown>;

    if (findings.length === 0) {
      if (isTerminalCompleteNoFindings(record)) {
        return { findings: [] };
      }

      if (isProgressRecord(record)) {
        throw makeUnusableOutputError("CodeRabbit output was a progress/status/heartbeat record");
      }

      if (isUnusableFindingRecord(record)) {
        throw makeUnusableOutputError("CodeRabbit output contained only bookkeeping records");
      }

      const rawFindings = record.findings ?? record.issues ?? record.results;
      if (Array.isArray(rawFindings) && rawFindings.length > 0) {
        const unusableCount = rawFindings.filter(
          (item) => typeof item === "object" && item !== null && isUnusableFindingRecord(item as Record<string, unknown>),
        ).length;
        if (unusableCount > 0) {
          throw makeUnusableOutputError(
            `CodeRabbit output contained only bookkeeping/progress records (${unusableCount} items)`,
          );
        }
      }
    }

    return {
      findings,
      ...(typeof record.prUrl === "string" ? { prUrl: record.prUrl } : {}),
    };
  }

  if (text.trim().length === 0) {
    return null;
  }

  if (format === "json" || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        const findings: CodeRabbitFindingLike[] = [];
        for (const item of parsed as unknown[]) {
          if (typeof item !== "object" || item === null) {
            continue;
          }
          const itemRecord = item as Record<string, unknown>;
          if (isErrorRecord(itemRecord)) {
            throw makeQcFailureError(
              classifyErrorType(itemRecord),
              `CodeRabbit provider returned an error in JSON array: ${itemRecord.message ?? itemRecord.errorType ?? "unknown"}`,
            );
          }
          if (isActionableFinding(itemRecord)) {
            findings.push(item as CodeRabbitFindingLike);
          }
        }
        if (findings.length === 0 && parsed.length > 0) {
          const unusableCount = (parsed as unknown[]).filter(
            (item) => typeof item === "object" && item !== null && isUnusableFindingRecord(item as Record<string, unknown>),
          ).length;
          if (unusableCount > 0) {
            throw makeUnusableOutputError(
              `CodeRabbit output contained only progress/status/heartbeat and bookkeeping records (${unusableCount} items)`,
            );
          }
        }
        return { findings };
      }
      const findings = parseFindingsFromPayload(parsed);
      if (findings.length === 0) {
        const parsedRecord = parsed as Record<string, unknown>;
        if (isTerminalCompleteNoFindings(parsedRecord)) {
          return { findings: [] };
        }
        if (isProgressRecord(parsedRecord)) {
          throw makeUnusableOutputError("CodeRabbit output was a progress/status/heartbeat record");
        }
        if (isUnusableFindingRecord(parsedRecord)) {
          throw makeUnusableOutputError("CodeRabbit output contained only bookkeeping records");
        }

        const rawFindings = parsedRecord.findings ?? parsedRecord.issues ?? parsedRecord.results;
        if (Array.isArray(rawFindings) && rawFindings.length > 0) {
          const unusableCount = rawFindings.filter(
            (item) => typeof item === "object" && item !== null && isUnusableFindingRecord(item as Record<string, unknown>),
          ).length;
          if (unusableCount > 0) {
            throw makeUnusableOutputError(
              `CodeRabbit output contained only bookkeeping/progress records (${unusableCount} items)`,
            );
          }
        }
      }
      return {
        findings,
        ...(typeof (parsed as Record<string, unknown>)?.prUrl === "string"
          ? { prUrl: (parsed as Record<string, unknown>).prUrl as string }
          : {}),
      };
    } catch (jsonError) {
      // Semantic failures (e.g. unusable-output) surfaced during JSON object/array
      // parsing must not be swallowed; only true JSON parse errors fall through to
      // JSONL line scanning when the format is not explicitly JSON.
      if (
        typeof jsonError === "object" &&
        jsonError !== null &&
        "qcFailureReason" in jsonError
      ) {
        throw jsonError;
      }
      if (format === "json") {
        throw jsonError;
      }
    }
  }

  // JSONL or generic line scanning: one finding per line
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const lineFindings: CodeRabbitFindingLike[] = [];
  let progressLineCount = 0;
  let unusableLineCount = 0;
  let parsedLineCount = 0;
  let sawExplicitSkip = false;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      parsedLineCount++;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (isTerminalCompleteNoFindings(record)) {
        sawExplicitSkip = true;
      }
      if (isErrorRecord(record)) {
        throw makeQcFailureError(
          classifyErrorType(record),
          `CodeRabbit provider returned an error in JSONL: ${record.message ?? record.errorType ?? "unknown"}`,
        );
      }
      if (isProgressRecord(record)) {
        progressLineCount++;
        continue;
      }
      if (isActionableFinding(record)) {
        lineFindings.push(parsed as CodeRabbitFindingLike);
      } else if (isUnusableFindingRecord(record)) {
        unusableLineCount++;
      }
    } catch (err) {
      if (typeof err === "object" && err !== null && "qcFailureReason" in err) {
        throw err;
      }
      // Ignore unparseable lines.
    }
  }
  if (lineFindings.length > 0) {
    return { findings: lineFindings };
  }
  if (sawExplicitSkip) {
    return { findings: [] };
  }
  if (progressLineCount > 0 || unusableLineCount > 0) {
    throw makeUnusableOutputError(
      `CodeRabbit output contained only progress/status/heartbeat and bookkeeping records (${progressLineCount + unusableLineCount} lines)`,
    );
  }
  if (parsedLineCount > 0) {
    throw new Error("CodeRabbit output contained no actionable findings");
  }

  throw new Error("CodeRabbit output could not be parsed as JSON, JSONL, or metrics payload");
}

function normalizeFinding(raw: CodeRabbitFindingLike, index: number): QcFinding {
  const severityLabel = pickString(raw.severity, raw.level) ?? "info";
  const severity: QcSeverity = normalizeSeverity(severityLabel);
  const title = pickString(raw.title, raw.summary, raw.rule, raw.type, raw.category) ?? `Finding #${index + 1}`;
  const message = pickString(raw.message, raw.description, raw.body, raw.codegenInstructions);
  const filePath = pickString(raw.file, raw.filePath, raw.path, raw.fileName);
  const suggestedAction = pickString(
    raw.suggestion,
    raw.suggestedAction,
    raw.fix,
    ...(Array.isArray(raw.suggestions) ? raw.suggestions : []),
  );
  const providerFindingId = pickString(raw.providerFindingId, raw.id, raw.findingId);
  const confidence = coerceNumber(raw.confidence);

  const attribution: QcAttribution = {
    confidence: "unattributed",
    reason: "provider-uncertain",
    filePath,
  };

  const fixAvailable =
    raw.fixAvailable === true ||
    raw.autofixEligible === true ||
    Boolean(raw.fix) ||
    Boolean(raw.codegenInstructions);

  return {
    findingId: `coderabbit-${index + 1}-${Date.now()}`,
    ...(providerFindingId ? { providerFindingId } : {}),
    severity,
    ...(pickString(raw.category, raw.type, raw.rule) ? { category: pickString(raw.category, raw.type, raw.rule) } : {}),
    title,
    ...(message ? { message } : {}),
    ...(filePath ? { filePath } : {}),
    range: filePath ? buildRange(raw) : undefined,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
    fixAvailable,
    autofixEligible: raw.autofixEligible === true || fixAvailable,
    attribution,
    status: "open",
  };
}

function computeResultStatus(findings: QcFinding[], providerFailed: boolean): QcResult["status"] {
  if (findings.length === 0) {
    return providerFailed ? "failed" : "passed";
  }
  const highestSeverity = findings.reduce(
    (max, finding) => maxSeverity(max, finding.severity),
    findings[0].severity,
  );
  if (highestSeverity === "critical") {
    return "blocked";
  }
  if (highestSeverity === "info") {
    return "passed";
  }
  return "findings";
}

const DEFAULT_CODERABBIT_CONFIG_PATH = ".coderabbit.yaml";

function buildResultFromReport(
  report: CodeRabbitReportLike | null,
  output: QcProviderOutput | QcMetricsPayload,
  mode: QcResult["providerMode"],
  providerFailed = false,
): QcResult {
  const now = new Date().toISOString();
  const rawFindings = report?.findings ?? [];
  const findings = rawFindings.map(normalizeFinding);

  return {
    schemaVersion: "1.0",
    qcRunId: `${output.provider}-${Date.now()}`,
    runId: "unknown",
    clusterId: "unknown",
    trigger: "completed-cluster",
    provider: output.provider,
    providerMode: mode,
    prUrl: report?.prUrl,
    startedAt: now,
    completedAt: now,
    status: computeResultStatus(findings, providerFailed),
    findings,
    rawArtifactPaths: "artifactPath" in output && output.artifactPath ? [output.artifactPath] : [],
    parserVersion: "coderabbit-1.0",
    policyDecision: {
      blocksDelivery: findings.some((f) => f.severity === "critical"),
      requiresOperatorReview: findings.some((f) => f.severity === "high" || f.severity === "critical"),
      routedToRepair: findings.some((f) => f.severity === "medium" || f.severity === "high" || f.severity === "critical"),
      summary:
        findings.length === 0
          ? "CodeRabbit review returned no findings."
          : `CodeRabbit review returned ${findings.length} finding(s).`,
    },
  };
}

/**
 * CodeRabbit-style QC adapter.
 *
 * Parses JSON, JSONL, and metrics payloads into normalized Polaris findings.
 * No external network calls are made here.
 */
export class CodeRabbitQcProvider implements IQcProvider {
  readonly name = "coderabbit";
  readonly supportedModes = ["local", "pr", "metrics-import"] as const;
  readonly capabilities = [
    "diff-review",
    "pr-review",
    "result-parsing",
    "auto-fix",
    "metrics-import",
  ] as const;

  constructor(private readonly config?: QcProviderConfig) {}

  canReview(scope: QcReviewScope): boolean {
    if (scope.prUrl) return true;
    return Boolean(scope.branch);
  }

  buildReviewCommand(scope: QcReviewScope): { command: string; args: string[] } {
    const execution = this.config?.execution;
    if (execution) {
      const args: string[] = execution.args ? [...execution.args] : [];
      const configPath = execution.configPath ?? DEFAULT_CODERABBIT_CONFIG_PATH;
      args.push("--config", configPath);
      const baseRef = scope.baseRef ?? scope.branch ?? "main";
      if (scope.prUrl) {
        args.push("--pr-url", scope.prUrl);
      } else {
        args.push("--base", baseRef);
      }
      return { command: execution.command, args };
    }

    const baseRef = scope.baseRef ?? scope.branch ?? "main";
    const args = scope.prUrl
      ? ["review", "--agent", "--pr-url", scope.prUrl]
      : ["review", "--agent", "--base", baseRef];
    args.push("--config", DEFAULT_CODERABBIT_CONFIG_PATH);
    return { command: "coderabbit", args };
  }

  parse(output: QcProviderOutput): QcResult {
    const outputConfig = this.config?.execution?.output;
    const report = parseReport(
      output,
      outputConfig?.format as "json" | "jsonl" | "sarif" | "generic" | undefined,
      outputConfig?.parser,
    );
    return buildResultFromReport(report, output, "local", output.exitCode !== 0);
  }

  importMetrics(payload: QcMetricsPayload): QcResult {
    const report = parseReport(payload);
    return buildResultFromReport(report, payload, "metrics-import");
  }
}
