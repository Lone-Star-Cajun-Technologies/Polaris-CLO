import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../../config/loader.js";
import { TerminalCliAdapter } from "./terminal-cli.js";
import type { BootstrapPacket } from "./types.js";

type SubtaskDispatchRequest = {
  packet: BootstrapPacket;
  instructions: string;
  returnContract: string[];
};

type GlobalSubtaskDispatcher = (
  request: SubtaskDispatchRequest
) => Promise<string | Record<string, unknown>>;

type PacketWithResultContract = BootstrapPacket & {
  result_file_contract?: { result_file?: string };
};

function selectBridgeProvider(providers: Record<string, unknown>): string | null {
  const preferred = process.env.POLARIS_NATIVE_SUBTASK_PROVIDER?.trim();
  if (preferred && preferred.length > 0 && Object.prototype.hasOwnProperty.call(providers, preferred)) {
    return preferred;
  }
  if (Object.prototype.hasOwnProperty.call(providers, "copilot")) {
    return "copilot";
  }
  return null;
}

function parseSummaryObject(summary: string): Record<string, unknown> | null {
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(candidate) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeSealedStatus(raw: unknown): "success" | "failure" | "blocked" {
  const status = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (status === "done" || status === "success") {
    return "success";
  }
  if (status === "blocked") {
    return "blocked";
  }
  return "failure";
}

function writeSealedResultFromSummary(
  packet: PacketWithResultContract,
  parsedSummary: Record<string, unknown>,
): void {
  const resultFile = packet.result_file_contract?.result_file;
  if (!resultFile) {
    return;
  }

  const commit =
    (typeof parsedSummary["commit"] === "string" && parsedSummary["commit"]) ||
    (typeof parsedSummary["commit_hash"] === "string" && parsedSummary["commit_hash"]) ||
    undefined;
  const validation = parsedSummary["validation"] ?? parsedSummary["validation_summary"];

  const sealedResult: Record<string, unknown> = {
    run_id: packet.run_id,
    cluster_id: packet.cluster_id,
    child_id: packet.active_child,
    status: normalizeSealedStatus(parsedSummary["status"]),
  };
  if (commit) {
    sealedResult["commit"] = commit;
  }
  if (validation !== undefined) {
    sealedResult["validation"] = validation;
  }

  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, JSON.stringify(sealedResult, null, 2), "utf-8");
}

export function installCliSubtaskBridge(repoRoot: string): void {
  const host = globalThis as typeof globalThis & {
    __POLARIS_AGENT_SUBTASK_DISPATCH__?: GlobalSubtaskDispatcher;
  };
  if (host.__POLARIS_AGENT_SUBTASK_DISPATCH__) {
    return;
  }

  const config = loadConfig(repoRoot);
  const execution = config.execution;
  if (!execution || !execution.providers) {
    return;
  }

  const provider = selectBridgeProvider(execution.providers);
  if (!provider) {
    return;
  }

  const adapter = new TerminalCliAdapter(execution);

  host.__POLARIS_AGENT_SUBTASK_DISPATCH__ = async ({ packet }) => {
    const result = await adapter.dispatch(packet, { provider });
    const summary = result.summary ?? result.stdout ?? result.stderr ?? "";
    if (result.exit_code !== 0) {
      throw new Error(
        `CLI subtask bridge provider "${provider}" failed: ${summary || "no summary available"}`
      );
    }
    const parsedSummary = parseSummaryObject(summary);
    if (!parsedSummary) {
      throw new Error(
        `CLI subtask bridge provider "${provider}" returned non-JSON summary required for sealed result contract`
      );
    }
    writeSealedResultFromSummary(packet as PacketWithResultContract, parsedSummary);
    return parsedSummary;
  };
}
