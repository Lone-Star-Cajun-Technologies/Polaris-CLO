import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isThinPointer } from "./adopt-assets.js";

export type AgentReconcileOutcome =
  | "already-present"
  | "compressed"
  | "refused"
  | "skipped";

export interface AgentReconcileRecord {
  file: string;
  outcome: AgentReconcileOutcome;
  genesisPath?: string;
}

export interface ReconcileOptions {
  anthropicKey?: string;
  now?: Date;
  dryRun?: boolean;
}

interface GenesisProvenanceRecord {
  source_path: string;
  backup_path: string | null;
  decision: string;
  timestamp: string;
  migration_outcome: AgentReconcileOutcome;
}

const AGENT_FILES = ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"];

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isAlreadyPointer(content: string): boolean {
  // isThinPointer checks for POLARIS.md; also accept POLARIS_RULES.md references
  if (isThinPointer(content)) return true;
  // Check for POLARIS_RULES.md thin pointer (≤3 meaningful lines + POLARIS_RULES.md reference)
  const lines = content.split("\n");
  const meaningfulLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^<!--.*-->$/.test(trimmed)) return false;
    return true;
  });
  return meaningfulLines.length <= 3 && meaningfulLines.some((line) => line.includes("POLARIS_RULES.md"));
}

function appendGenesisProvenance(
  repoRoot: string,
  records: GenesisProvenanceRecord[],
  dryRun = false,
): void {
  if (dryRun) return;
  if (records.length === 0) return;

  const provenancePath = join(repoRoot, ".polaris", "adoption-provenance.json");
  mkdirSync(join(repoRoot, ".polaris"), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(provenancePath)) {
    try {
      const parsed = JSON.parse(readFileSync(provenancePath, "utf-8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }

  const prior = Array.isArray(existing.genesis_reconcile_actions)
    ? (existing.genesis_reconcile_actions as unknown[])
    : [];

  const updated = {
    ...existing,
    updated_at: new Date().toISOString(),
    genesis_reconcile_actions: [...prior, ...records],
  };

  writeFileSync(provenancePath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
}

export async function reconcileAgentFiles(
  repoRoot: string,
  options?: ReconcileOptions,
): Promise<AgentReconcileRecord[]> {
  const results: AgentReconcileRecord[] = [];
  const provenanceRecords: GenesisProvenanceRecord[] = [];
  const now = options?.now ?? new Date();
  const timestamp = now.toISOString();
  const dryRun = options?.dryRun ?? false;

  for (const file of AGENT_FILES) {
    const filePath = join(repoRoot, file);

    if (!existsSync(filePath)) {
      continue;
    }

    const content = readFileSync(filePath, "utf8");

    if (isAlreadyPointer(content)) {
      results.push({ file, outcome: "already-present" });
      provenanceRecords.push({
        source_path: file,
        backup_path: null,
        decision: "already-pointer",
        timestamp,
        migration_outcome: "already-present",
      });
      continue;
    }

    if (dryRun) {
      process.stdout.write(
        `[dry-run] would prompt to compress and archive ${file} as genesis doctrine\n`,
      );
      results.push({ file, outcome: "skipped" });
      continue;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await rl.question(
        `\n${file} has existing content. Compress and archive as genesis doctrine? (Requires ANTHROPIC_API_KEY) [Y/n]: `,
      );
    } finally {
      rl.close();
    }

    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "n" || trimmed === "no") {
      const pointer = `<!-- See [POLARIS_RULES.md](POLARIS_RULES.md) for repo instructions -->\n`;
      writeFileSync(filePath, pointer + content, "utf8");
      results.push({ file, outcome: "refused" });
      provenanceRecords.push({
        source_path: file,
        backup_path: null,
        decision: "refused-compression",
        timestamp,
        migration_outcome: "refused",
      });
      continue;
    }

    // Accepted — attempt compression
    const apiKey = options?.anthropicKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      process.stderr.write(
        `Warning: ANTHROPIC_API_KEY not found. Skipping compression of ${file}.\n`,
      );
      results.push({ file, outcome: "skipped" });
      provenanceRecords.push({
        source_path: file,
        backup_path: null,
        decision: "skipped-no-api-key",
        timestamp,
        migration_outcome: "skipped",
      });
      continue;
    }

    let Anthropic: { new (opts: { apiKey: string }): unknown };
    try {
      // @ts-ignore: @anthropic-ai/sdk may not be installed as a dependency
      const mod = await import("@anthropic-ai/sdk");
      Anthropic = (mod as { default: typeof Anthropic }).default;
    } catch {
      process.stderr.write(
        `Warning: @anthropic-ai/sdk not installed. Skipping compression of ${file}.\n`,
      );
      results.push({ file, outcome: "skipped" });
      provenanceRecords.push({
        source_path: file,
        backup_path: null,
        decision: "skipped-no-sdk",
        timestamp,
        migration_outcome: "skipped",
      });
      continue;
    }

    const client = new (Anthropic as new (opts: { apiKey: string }) => {
      messages: {
        create: (opts: {
          model: string;
          max_tokens: number;
          messages: { role: string; content: string }[];
        }) => Promise<{ content: { type: string; text: string }[] }>;
      };
    })({ apiKey });

    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Distill the following agent instructions into concise bullet-point rules that preserve all essential guidance:\n\n${content}`,
        },
      ],
    });

    const distilled = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const dateStr = formatDate(now);
    const genesisPath = `smartdocs/doctrine/active/${dateStr}-genesis-agent-doctrine.md`;
    const genesisFullPath = join(repoRoot, genesisPath);

    if (!dryRun) {
      mkdirSync(join(repoRoot, "smartdocs/doctrine/active"), { recursive: true });
      writeFileSync(genesisFullPath, distilled, "utf8");
      const thinPointer =
        `# Agent Instructions\n\nRead [POLARIS_RULES.md](POLARIS_RULES.md) before beginning any work.\n\n` +
        `<!-- genesis doctrine archived: ${genesisPath} -->\n`;
      writeFileSync(filePath, thinPointer, "utf8");
    }

    results.push({ file, outcome: "compressed", genesisPath });
    provenanceRecords.push({
      source_path: file,
      backup_path: genesisPath,
      decision: "accepted-compression",
      timestamp,
      migration_outcome: "compressed",
    });
  }

  appendGenesisProvenance(repoRoot, provenanceRecords, dryRun);
  return results;
}
