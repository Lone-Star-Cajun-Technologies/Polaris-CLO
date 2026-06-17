import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { ReviewPacket } from "../governance/types.js";

export interface DispatchResult {
  decision: "approve" | "reject" | "defer";
  reasoning: string;
  provider: string;
}

export interface ProviderConfig {
  command: string;
  args: string[];
}

export interface LibrarianDispatchOptions {
  packet: ReviewPacket;
  repoRoot: string;
  providers: Record<string, ProviderConfig>;
  providerOrder: string[];
}

// Returns the first provider name from providerOrder whose command is installed (via `which`)
export function resolveLibrarianProvider(
  providers: Record<string, ProviderConfig>,
  providerOrder: string[],
): string | null {
  for (const name of providerOrder) {
    const cfg = providers[name];
    if (!cfg) continue;
    const cmd =
      cfg.command === "env"
        ? (cfg.args ?? []).find((a) => !a.includes("=") && !a.startsWith("-")) ?? cfg.command
        : cfg.command;
    try {
      const { status } = spawnSync("which", [cmd], { stdio: "ignore" });
      if (status === 0) return name;
    } catch {
      continue;
    }
  }
  return null;
}

function grepEvidence(repoRoot: string, symbols: string[]): Record<string, string> {
  const evidence: Record<string, string> = {};
  for (const sym of symbols.slice(0, 8)) {
    try {
      const result = spawnSync(
        "grep",
        [
          "-r",
          "--include=*.ts",
          "--include=*.tsx",
          "--include=*.swift",
          "--include=*.dart",
          "-l",
          sym,
          ".",
        ],
        { cwd: repoRoot, encoding: "utf-8", timeout: 5000 },
      );
      const files = (result.stdout ?? "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, 3);
      evidence[sym] = files.length > 0 ? `found in: ${files.join(", ")}` : "not found in codebase";
    } catch {
      evidence[sym] = "search error";
    }
  }
  return evidence;
}

export async function dispatchLibrarianReview(
  options: LibrarianDispatchOptions,
): Promise<DispatchResult> {
  const { packet, repoRoot, providers, providerOrder } = options;
  const providerName = resolveLibrarianProvider(providers, providerOrder);
  if (!providerName) {
    throw new Error(
      "No librarian provider available. Run `polaris agent setup` to configure one.",
    );
  }

  const cfg = providers[providerName];
  const staleSymbols: string[] =
    ((packet as unknown as Record<string, unknown>).staleSymbols as string[]) ?? [];
  const evidence = grepEvidence(repoRoot, staleSymbols);

  let docContent = "";
  try {
    if (existsSync(packet.sourcePath)) {
      docContent = readFileSync(packet.sourcePath, "utf-8").slice(0, 2000);
    }
  } catch {
    /* ignore */
  }

  const evidenceLines = Object.entries(evidence)
    .map(([sym, result]) => `  ${sym}: ${result}`)
    .join("\n");

  const prompt = `You are an agentic librarian reviewing a candidate documentation file for the Polaris docs review pipeline.

Doc path: ${packet.sourcePath}
Flag type: stale-reference
Stale symbols (flagged as not in the codebase graph):
${staleSymbols.join(", ")}

Live codebase evidence (grep results):
${evidenceLines}

Document content (first 2000 chars):
---
${docContent}
---

Decision rules:
- approve: symbols found in live codebase OR doc describes concepts still clearly relevant to current architecture
- reject: doc describes systems/components that are clearly gone with no trace in codebase
- defer: ambiguous — cannot determine from evidence alone

Respond with ONLY valid JSON on a single line:
{"decision":"approve"|"reject"|"defer","reasoning":"one sentence"}`;

  const args = (cfg.args ?? []).map((a) => (a === "{{worker_prompt}}" ? prompt : a));
  const result = spawnSync(cfg.command, args, {
    encoding: "utf-8",
    timeout: 60000,
    cwd: repoRoot,
  });

  const stdout = (result.stdout ?? "").trim();
  const jsonLine = stdout
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{") && l.includes("decision"));
  if (!jsonLine) {
    return {
      decision: "defer",
      reasoning: "Provider response did not contain a valid JSON decision",
      provider: providerName,
    };
  }
  try {
    const parsed = JSON.parse(jsonLine) as { decision: string; reasoning: string };
    const decision = (
      ["approve", "reject", "defer"].includes(parsed.decision) ? parsed.decision : "defer"
    ) as DispatchResult["decision"];
    return { decision, reasoning: parsed.reasoning ?? "", provider: providerName };
  } catch {
    return { decision: "defer", reasoning: "Could not parse provider response", provider: providerName };
  }
}
