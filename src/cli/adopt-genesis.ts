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
}

const AGENT_FILES = ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"];

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function reconcileAgentFiles(
  repoRoot: string,
  options?: ReconcileOptions,
): Promise<AgentReconcileRecord[]> {
  const results: AgentReconcileRecord[] = [];

  for (const file of AGENT_FILES) {
    const filePath = join(repoRoot, file);

    if (!existsSync(filePath)) {
      continue;
    }

    const content = readFileSync(filePath, "utf8");

    if (isThinPointer(content)) {
      results.push({ file, outcome: "already-present" });
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
      const pointer = `<!-- See [POLARIS.md](POLARIS.md) for repo instructions -->\n`;
      writeFileSync(filePath, pointer + content, "utf8");
      results.push({ file, outcome: "refused" });
      continue;
    }

    // Accepted — attempt compression
    const apiKey = options?.anthropicKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      process.stderr.write(
        `Warning: ANTHROPIC_API_KEY not found. Skipping compression of ${file}.\n`,
      );
      results.push({ file, outcome: "skipped" });
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

    const now = options?.now ?? new Date();
    const dateStr = formatDate(now);
    const genesisPath = `smartdocs/doctrine/active/${dateStr}-genesis-agent-doctrine.md`;
    const genesisFullPath = join(repoRoot, genesisPath);

    mkdirSync(join(repoRoot, "smartdocs/doctrine/active"), { recursive: true });
    writeFileSync(genesisFullPath, distilled, "utf8");

    const thinPointer =
      `# Agent Instructions\n\nRead [POLARIS.md](POLARIS.md) before beginning any work.\n\n` +
      `<!-- genesis doctrine archived: ${genesisPath} -->\n`;
    writeFileSync(filePath, thinPointer, "utf8");

    results.push({ file, outcome: "compressed", genesisPath });
  }

  return results;
}
