import { spawnSync } from "node:child_process";
import * as readline from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ForemanBinding {
  provider: string;
  roleFile: string;
}

const SUPPORTED_PROVIDERS = [
  { name: "claude",  detectCmd: "claude",  displayName: "Claude (Anthropic)" },
  { name: "codex",   detectCmd: "codex",   displayName: "Codex (OpenAI)"     },
  { name: "copilot", detectCmd: "copilot", displayName: "Copilot (GitHub)"   },
  { name: "devin",   detectCmd: "devin",   displayName: "Devin (Cognition)"  },
  { name: "gemini",  detectCmd: "gemini",  displayName: "Gemini (Google)"    },
];

const ROLES = ["librarian", "foreman", "worker", "analyst"] as const;

function isInstalled(cmd: string): boolean {
  const { status } = spawnSync("which", [cmd], { stdio: "ignore" });
  return status === 0;
}

function detectProviders(): Array<{ name: string; displayName: string; installed: boolean }> {
  return SUPPORTED_PROVIDERS.map((p) => ({
    name: p.name,
    displayName: p.displayName,
    installed: isInstalled(p.detectCmd),
  }));
}

async function selectProvider(
  role: string,
  detected: Array<{ name: string; displayName: string; installed: boolean }>,
  currentProviders: string[],
): Promise<string | null> {
  const installed = detected.filter((p) => p.installed);
  if (installed.length === 0) return null;

  console.log(`\nRole: ${role}`);
  detected.forEach((p, i) => {
    const marker = p.installed ? "✓" : "✗";
    const current = currentProviders.includes(p.name) ? " (current)" : "";
    const selectable = p.installed ? `[${i + 1}]` : "   ";
    console.log(`  ${selectable} ${marker} ${p.displayName}${current}`);
  });

  const defaultChoice =
    installed.find((p) => currentProviders.includes(p.name)) ?? installed[0];
  const defaultIdx = detected.indexOf(defaultChoice) + 1;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(`\nSelect provider for ${role} [${defaultIdx}]: `, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim() || String(defaultIdx), 10) - 1;
      const chosen = detected[idx];
      if (!chosen?.installed) {
        console.log("  That provider is not installed. Using default.");
        res(defaultChoice.name);
      } else {
        res(chosen.name);
      }
    });
  });
}

/**
 * Resolves the Foreman provider for init/adopt.
 *
 * If `execution.providerPolicy.foreman.providers[0]` is already set in config,
 * returns a binding immediately (no prompt). Otherwise prompts once, persists
 * the choice to polaris.config.json, and returns the binding.
 *
 * The binding always references `.polaris/roles/foreman.md` — role text is not
 * duplicated here.
 */
export async function resolveForeman(
  repoRoot: string,
  config: Record<string, unknown>,
  opts?: {
    writeConfig?: (path: string, data: Record<string, unknown>) => void;
    detectProviders?: () => Array<{ name: string; displayName: string; installed: boolean }>;
    /** Override prompt; receives detected providers list and returns chosen name or null. */
    selectProvider?: (
      detected: Array<{ name: string; displayName: string; installed: boolean }>,
    ) => Promise<string | null>;
  },
): Promise<ForemanBinding> {
  const execution = (config.execution as Record<string, unknown>) ?? {};
  const providerPolicy = (execution.providerPolicy as Record<string, unknown>) ?? {};
  const foremanPolicy = (providerPolicy.foreman as Record<string, unknown>) ?? {};
  const existing = (foremanPolicy.providers as string[] | undefined)?.[0];

  const roleFile = ".polaris/roles/foreman.md";

  if (existing) {
    return { provider: existing, roleFile };
  }

  // Prompt once for Foreman provider
  const detected = opts?.detectProviders?.() ?? detectProviders();
  const chosen = opts?.selectProvider
    ? await opts.selectProvider(detected)
    : await selectProvider("foreman", detected, []);
  if (!chosen) {
    throw new Error(
      "No supported agent installed. Cannot assign a Foreman. " +
        "Install one of: " + SUPPORTED_PROVIDERS.map((p) => p.name).join(", "),
    );
  }

  // Persist choice
  const updatedPolicy = {
    ...providerPolicy,
    foreman: { ...(foremanPolicy as object), providers: [chosen] },
  };
  const updatedConfig = {
    ...config,
    execution: { ...execution, providerPolicy: updatedPolicy },
  };

  const configPath = resolve(repoRoot, "polaris.config.json");
  if (opts?.writeConfig) {
    opts.writeConfig(configPath, updatedConfig);
  } else {
    writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2) + "\n");
  }

  return { provider: chosen, roleFile };
}

export async function runAgentSetup(repoRoot: string): Promise<void> {
  console.log("\nPolaris Agent Setup — configure one provider per role\n");
  const detected = detectProviders();

  const installed = detected.filter((p) => p.installed);
  if (installed.length === 0) {
    console.error(
      "No supported agents detected. Install one of: " +
        SUPPORTED_PROVIDERS.map((p) => p.name).join(", "),
    );
    process.exit(1);
  }

  console.log("Detected agents:");
  installed.forEach((p) => console.log(`  ✓ ${p.displayName}`));

  const configPath = resolve(repoRoot, "polaris.config.json");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    console.error(`polaris agent setup: could not read ${configPath}`);
    process.exit(1);
  }

  const execution = (config.execution as Record<string, unknown>) ?? {};
  const providerPolicy = (execution.providerPolicy as Record<string, unknown>) ?? {};

  for (const role of ROLES) {
    const currentProviders =
      ((providerPolicy[role] as Record<string, unknown>)?.providers as string[]) ?? [];
    const chosen = await selectProvider(role, detected, currentProviders);
    if (chosen) {
      providerPolicy[role] = {
        ...((providerPolicy[role] as object) ?? {}),
        providers: [chosen, ...currentProviders.filter((p) => p !== chosen)],
      };
      console.log(`  → ${role}: ${chosen}`);
    }
  }

  execution.providerPolicy = providerPolicy;
  config.execution = execution;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nAgent configuration saved to ${configPath}`);
}
