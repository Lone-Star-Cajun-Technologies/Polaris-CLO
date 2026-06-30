import { Command } from "commander";
import { getVersion } from "./version.js";
import { refreshPolarisRules } from "./adopt-rules.js";

export interface UpgradeCommandOptions {
  repoRoot?: string;
  refresh?: typeof refreshPolarisRules;
  getVersion?: typeof getVersion;
}

export function createUpgradeCommand(options: UpgradeCommandOptions = {}): Command {
  const repoRoot = options.repoRoot ?? process.cwd();
  const doRefresh = options.refresh ?? refreshPolarisRules;
  const getCurrentVersion = options.getVersion ?? getVersion;

  const cmd = new Command("upgrade")
    .description("Refresh POLARIS_RULES.md to the current Polaris CLI version")
    .option("-r, --repo-root <path>", "Repository root", repoRoot)
    .action(async (cmdOptions: { repoRoot?: string }) => {
      const targetRoot = cmdOptions.repoRoot ?? repoRoot;
      const version = getCurrentVersion();
      const result = doRefresh(targetRoot, version);
      if (result.status === "updated") {
        process.stdout.write(`POLARIS_RULES.md updated to version ${version}\n`);
      } else {
        process.stdout.write(`Already up to date (${version})\n`);
      }
    });

  return cmd;
}
