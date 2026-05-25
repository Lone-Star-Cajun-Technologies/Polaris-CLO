import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readState, validateState } from "./checkpoint.js";
import { loadConfig } from "../config/loader.js";
import type { BootstrapPacket } from "./bootstrap-packet.js";

export interface StatusOptions {
  stateFile?: string;
  repoRoot: string;
  json?: boolean;
}

function getCurrentBranch(repoRoot: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function computeStateSha(stateFile: string): string {
  const content = readFileSync(stateFile, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

function findLatestPacket(
  bootstrapDir: string,
  runId?: string,
): { path: string; packet: BootstrapPacket } | null {
  let entries: string[];
  try {
    entries = readdirSync(bootstrapDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const candidates = runId
    ? entries.filter((f) => f.startsWith(`${runId}-`)).sort()
    : entries.sort();
  if (candidates.length === 0) return null;
  const latest = candidates.at(-1)!;
  const fullPath = join(bootstrapDir, latest);
  try {
    const raw = readFileSync(fullPath, "utf-8");
    return { path: fullPath, packet: JSON.parse(raw) as BootstrapPacket };
  } catch {
    return null;
  }
}

export function runLoopStatus(options: StatusOptions): void {
  const { repoRoot } = options;
  const config = loadConfig(repoRoot);
  const bootstrapDir = resolve(
    repoRoot,
    config.loop.bootstrapOutputPath ?? ".polaris/bootstrap",
  );
  const stateFile =
    options.stateFile ?? join(repoRoot, ".polaris", "runs", "current-state.json");

  let state: ReturnType<typeof readState>;
  try {
    const raw = readState(stateFile);
    const errors = validateState(raw);
    if (errors.length > 0) {
      console.error(`current-state.json invalid:\n${errors.join("\n")}`);
      process.exit(1);
    }
    state = raw;
  } catch (err) {
    console.error(
      `Error: cannot read state file ${stateFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const branch = getCurrentBranch(repoRoot);
  const openChildren: string[] = state.open_children ?? [];
  const blockedChildren: string[] = ((state as unknown as Record<string, unknown>)["blocked_children"] as string[] | undefined) ?? [];

  const packetResult = findLatestPacket(bootstrapDir, state.run_id);
  let packetFresh: boolean | null = null;
  let packetPathDisplay: string | null = null;
  let stateSha: string | null = null;

  if (packetResult) {
    try {
      stateSha = computeStateSha(stateFile);
      packetFresh = packetResult.packet.current_state_sha === stateSha;
      packetPathDisplay = packetResult.path.startsWith(repoRoot + "/")
        ? packetResult.path.slice(repoRoot.length + 1)
        : packetResult.path;
    } catch {
      packetFresh = false;
    }
  }

  const isDeadlock =
    openChildren.length > 0 &&
    blockedChildren.length > 0 &&
    openChildren.every((c) => blockedChildren.includes(c));

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          run_id: state.run_id,
          cluster_id: state.cluster_id,
          branch,
          session_type: state.session_type ?? null,
          active_child: state.active_child || null,
          step_cursor: state.step_cursor,
          status: state.status,
          context_budget: state.context_budget,
          completed_children: state.completed_children,
          open_children: openChildren,
          blocked_children: blockedChildren,
          deadlock: isDeadlock,
          bootstrap_packet: packetPathDisplay
            ? { path: packetPathDisplay, fresh: packetFresh }
            : null,
          state_sha: stateSha ? stateSha.slice(0, 12) : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  const maxChildren = state.context_budget.max_children_per_session ?? 3;
  const completed = state.context_budget.children_completed;
  const remaining = maxChildren - completed;

  const lines: string[] = [
    "Polaris Loop Status",
    "───────────────────",
    `Run ID:          ${state.run_id}`,
    `Cluster:         ${state.cluster_id}`,
    `Branch:          ${branch}`,
    `Session type:    ${state.session_type ?? "(not set)"}`,
    `Active child:    ${state.active_child || "(none)"}`,
    `Step cursor:     ${state.step_cursor ?? "(none)"}`,
    `Context budget:  ${completed}/${maxChildren} children completed (${remaining} remaining)`,
    "",
    `Completed:       ${state.completed_children.length > 0 ? state.completed_children.join(", ") + ` (${state.completed_children.length})` : "none"}`,
    `Open:            ${openChildren.length > 0 ? openChildren.join(", ") + ` (${openChildren.length})` : "none"}`,
    `Blocked:         ${blockedChildren.length > 0 ? blockedChildren.join(", ") : "none"}`,
  ];

  if (packetPathDisplay) {
    const freshLabel = packetFresh
      ? "(fresh)"
      : "(stale — re-run `polaris loop continue`)";
    lines.push("");
    lines.push(`Bootstrap packet: ${packetPathDisplay} ${freshLabel}`);
    if (stateSha) {
      const matchLabel = packetFresh
        ? "matches current-state.json ✓"
        : "MISMATCH — state has changed";
      lines.push(`State SHA:        ${stateSha.slice(0, 12)}... (${matchLabel})`);
    }
  } else {
    lines.push("");
    lines.push("Bootstrap packet: (none found)");
  }

  if (isDeadlock) {
    lines.push("");
    lines.push("⚠ DEADLOCK DETECTED");
    lines.push("Blocked children:");
    for (const c of blockedChildren) {
      lines.push(`  ${c} — blocked`);
    }
    lines.push("Resolve blockers in Linear, then run: polaris loop resume");
  }

  console.log(lines.join("\n"));
}
