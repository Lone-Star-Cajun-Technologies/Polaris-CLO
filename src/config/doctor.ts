import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PolarisConfig } from "./schema.js";
import { loadConfig, PolarisConfigError } from "./loader.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  category: "config" | "provider" | "tracker" | "artifact";
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
}

function checkConfigFile(repoRoot: string): DoctorCheck {
  const configPath = resolve(repoRoot, "polaris.config.json");
  
  if (!existsSync(configPath)) {
    return {
      id: "config-file-exists",
      category: "config",
      status: "warn",
      message: "polaris.config.json not found",
      detail: "Using default configuration. Create polaris.config.json to customize.",
    };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    JSON.parse(raw);
    return {
      id: "config-file-exists",
      category: "config",
      status: "pass",
      message: "polaris.config.json exists and is valid JSON",
    };
  } catch (err) {
    return {
      id: "config-file-exists",
      category: "config",
      status: "fail",
      message: "polaris.config.json is invalid JSON",
      detail: (err as Error).message,
    };
  }
}

function checkConfigValidation(repoRoot: string): DoctorCheck {
  try {
    loadConfig(repoRoot);
    return {
      id: "config-validation",
      category: "config",
      status: "pass",
      message: "Configuration passes validation",
    };
  } catch (err) {
    if (err instanceof PolarisConfigError) {
      return {
        id: "config-validation",
        category: "config",
        status: "fail",
        message: "Configuration validation failed",
        detail: err.errors.join("\n"),
      };
    }
    return {
      id: "config-validation",
      category: "config",
      status: "fail",
      message: "Configuration validation error",
      detail: (err as Error).message,
    };
  }
}

function checkProviderConfig(config: PolarisConfig): DoctorCheck {
  const hasProviders = config.execution?.providers && Object.keys(config.execution.providers).length > 0;
  
  if (!hasProviders) {
    return {
      id: "provider-config",
      category: "provider",
      status: "warn",
      message: "No external providers configured",
      detail: "External agent providers are optional. Configure execution.providers to use external agents.",
    };
  }

  const providers = config.execution!.providers!;
  const invalidProviders = Object.entries(providers).filter(([_, provider]) => {
    return !provider.command || typeof provider.command !== "string" || provider.command.trim() === "";
  });

  if (invalidProviders.length > 0) {
    return {
      id: "provider-config",
      category: "provider",
      status: "fail",
      message: "Some providers are misconfigured",
      detail: `Providers missing valid command: ${invalidProviders.map(([name]) => name).join(", ")}`,
    };
  }

  return {
    id: "provider-config",
    category: "provider",
    status: "pass",
    message: "External providers are configured",
    detail: `Found ${Object.keys(providers).length} provider(s)`,
  };
}

function checkTrackerConfig(config: PolarisConfig): DoctorCheck {
  const tracker = config.tracker;
  
  if (!tracker) {
    return {
      id: "tracker-config",
      category: "tracker",
      status: "pass",
      message: "No tracker configured (local mode)",
      detail: "Tracker is optional. Polaris will operate in local-file mode.",
    };
  }

  const hasAdapter = tracker.adapter;
  if (!hasAdapter) {
    return {
      id: "tracker-config",
      category: "tracker",
      status: "pass",
      message: "No tracker adapter configured (local mode)",
      detail: "Tracker adapter is optional. Polaris will operate in local-file mode.",
    };
  }

  if (tracker.adapter === "linear") {
    const linearConfig = tracker.linear;
    if (!linearConfig?.enabled) {
      return {
        id: "tracker-config",
        category: "tracker",
        status: "warn",
        message: "Linear tracker adapter selected but not enabled",
        detail: "Set tracker.linear.enabled to true to use Linear integration.",
      };
    }
    if (!linearConfig.teamId || !linearConfig.projectId) {
      return {
        id: "tracker-config",
        category: "tracker",
        status: "warn",
        message: "Linear tracker enabled but missing teamId or projectId",
        detail: "Configure tracker.linear.teamId and tracker.linear.projectId for full Linear integration.",
      };
    }
    return {
      id: "tracker-config",
      category: "tracker",
      status: "pass",
      message: "Linear tracker is configured",
    };
  }

  if (tracker.adapter === "mcp-bridge") {
    const mcpConfig = tracker.mcpBridge;
    if (!mcpConfig?.enabled) {
      return {
        id: "tracker-config",
        category: "tracker",
        status: "warn",
        message: "MCP bridge tracker adapter selected but not enabled",
        detail: "Set tracker.mcpBridge.enabled to true to use MCP bridge integration.",
      };
    }
    return {
      id: "tracker-config",
      category: "tracker",
      status: "pass",
      message: "MCP bridge tracker is configured",
    };
  }

  if (tracker.adapter === "local") {
    return {
      id: "tracker-config",
      category: "tracker",
      status: "pass",
      message: "Local file tracker adapter is configured",
    };
  }

  if (tracker.adapter === "spec") {
    return {
      id: "tracker-config",
      category: "tracker",
      status: "pass",
      message: "Spec tracker adapter is configured",
    };
  }

  return {
    id: "tracker-config",
    category: "tracker",
    status: "warn",
    message: "Unknown tracker adapter configured",
    detail: `Adapter: ${tracker.adapter}`,
  };
}

function checkArtifactHygiene(repoRoot: string): DoctorCheck {
  const polarisDir = resolve(repoRoot, ".polaris");
  const taskchainDir = resolve(repoRoot, ".taskchain_artifacts");
  
  const hasPolarisDir = existsSync(polarisDir);
  const hasTaskchainDir = existsSync(taskchainDir);
  
  if (!hasPolarisDir && !hasTaskchainDir) {
    return {
      id: "artifact-hygiene",
      category: "artifact",
      status: "pass",
      message: "No Polaris artifact directories found",
      detail: "This is expected for a fresh repository. Run 'polaris init' to set up.",
    };
  }

  const issues: string[] = [];
  
  if (hasPolarisDir) {
    const runsDir = resolve(polarisDir, "runs");
    if (existsSync(runsDir)) {
      issues.push(".polaris/runs directory exists (contains run artifacts)");
    }
  }
  
  if (hasTaskchainDir) {
    const runsDir = resolve(taskchainDir, "polaris-run", "runs");
    if (existsSync(runsDir)) {
      issues.push(".taskchain_artifacts/polaris-run/runs directory exists (contains run artifacts)");
    }
  }

  if (issues.length === 0) {
    return {
      id: "artifact-hygiene",
      category: "artifact",
      status: "pass",
      message: "Artifact directories are clean",
    };
  }

  return {
    id: "artifact-hygiene",
    category: "artifact",
    status: "warn",
    message: "Runtime artifacts present in repository",
    detail: issues.join("\n"),
  };
}

export function runDoctor(repoRoot: string): DoctorReport {
  const checks: DoctorCheck[] = [];
  
  // Config checks
  checks.push(checkConfigFile(repoRoot));
  checks.push(checkConfigValidation(repoRoot));
  
  // Provider checks (only if config loaded successfully)
  try {
    const config = loadConfig(repoRoot);
    checks.push(checkProviderConfig(config));
    checks.push(checkTrackerConfig(config));
  } catch {
    // Skip provider/tracker checks if config failed to load
  }
  
  // Artifact checks
  checks.push(checkArtifactHygiene(repoRoot));
  
  const summary = {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
  
  return { checks, summary };
}

export function printDoctorReport(report: DoctorReport): void {
  const { checks, summary } = report;
  
  // Print summary
  console.log("\n=== Polaris Configuration Doctor ===\n");
  console.log(`Summary: ${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed\n`);
  
  // Group checks by category
  const categories = ["config", "provider", "tracker", "artifact"] as const;
  
  for (const category of categories) {
    const categoryChecks = checks.filter((c) => c.category === category);
    if (categoryChecks.length === 0) continue;
    
    console.log(`[${category.toUpperCase()}]`);
    for (const check of categoryChecks) {
      const statusSymbol = check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
      console.log(`  ${statusSymbol} ${check.message}`);
      if (check.detail) {
        console.log(`    ${check.detail}`);
      }
    }
    console.log();
  }
  
  // Exit with error code if any checks failed
  if (summary.fail > 0) {
    process.exit(1);
  }
}