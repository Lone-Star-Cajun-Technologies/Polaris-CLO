import type {
  IQcProvider,
  QcMetricsPayload,
  QcProviderOutput,
  QcReviewScope,
} from "../provider.js";
import type { QcAttribution, QcFinding, QcResult, QcSeverity } from "../types.js";
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

  if (Array.isArray(record.findings)) {
    return record.findings as CodeRabbitFindingLike[];
  }

  if (Array.isArray(record.issues)) {
    return record.issues as CodeRabbitFindingLike[];
  }

  if (Array.isArray(record.results)) {
    return record.results as CodeRabbitFindingLike[];
  }

  // Single finding wrapped in an object
  if (
    record.severity !== undefined ||
    record.message !== undefined ||
    record.title !== undefined
  ) {
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
        return { findings: parsed as CodeRabbitFindingLike[] };
      }
      return {
        findings: parseFindingsFromPayload(parsed),
        ...(typeof (parsed as Record<string, unknown>)?.prUrl === "string"
          ? { prUrl: (parsed as Record<string, unknown>).prUrl as string }
          : {}),
      };
    } catch (jsonError) {
      // When the format is explicitly JSON, a parse error is a real failure.
      // Otherwise, treat the text as JSONL and fall through to line scanning.
      if (format === "json") {
        throw jsonError;
      }
    }
  }

  // JSONL or generic line scanning: one finding per line
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const lineFindings: CodeRabbitFindingLike[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as CodeRabbitFindingLike;
      lineFindings.push(parsed);
    } catch {
      // Ignore unparseable lines.
    }
  }
  if (lineFindings.length > 0) {
    return { findings: lineFindings };
  }

  throw new Error("CodeRabbit output could not be parsed as JSON, JSONL, or metrics payload");
}

function normalizeFinding(raw: CodeRabbitFindingLike, index: number): QcFinding {
  const severityLabel = pickString(raw.severity, raw.level) ?? "info";
  const severity: QcSeverity = normalizeSeverity(severityLabel);
  const title = pickString(raw.title, raw.summary, raw.rule, raw.type, raw.category) ?? `Finding #${index + 1}`;
  const message = pickString(raw.message, raw.description, raw.body);
  const filePath = pickString(raw.file, raw.filePath, raw.path);
  const suggestedAction = pickString(raw.suggestion, raw.suggestedAction, raw.fix);
  const providerFindingId = pickString(raw.providerFindingId, raw.id, raw.findingId);
  const confidence = coerceNumber(raw.confidence);

  const attribution: QcAttribution = {
    confidence: "unattributed",
    reason: "provider-uncertain",
    filePath,
  };

  const fixAvailable = raw.fixAvailable === true || raw.autofixEligible === true || Boolean(raw.fix);

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
      if (execution.configPath) {
        args.push("--config", execution.configPath);
      }
      if (scope.prUrl) {
        args.push("--pr-url", scope.prUrl);
      } else if (scope.branch) {
        args.push("--branch", scope.branch);
      }
      return { command: execution.command, args };
    }

    if (scope.prUrl) {
      return { command: "coderabbit", args: ["review", "--agent", "--pr-url", scope.prUrl] };
    }
    return {
      command: "coderabbit",
      args: ["review", "--agent", "--branch", scope.branch ?? "HEAD"],
    };
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
