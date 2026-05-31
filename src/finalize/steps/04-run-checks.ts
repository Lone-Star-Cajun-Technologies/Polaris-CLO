import { execFileSync, spawnSync } from "node:child_process";

function parseShellArgs(cmdLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < cmdLine.length; i++) {
    const char = cmdLine[i]!;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

export interface RunChecksOptions {
  activeClusterId?: string;
  skipDelivery?: boolean;
}

function normalizeGitPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function getStagedPaths(repoRoot: string): string[] {
  const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  return output
    .split("\n")
    .map((line) => normalizeGitPath(line.trim()))
    .filter(Boolean);
}

function isBlockedDeliveryPath(filePath: string): boolean {
  return (
    filePath.startsWith(".taskchain_artifacts/")
    || filePath.endsWith(".bak")
    || filePath.startsWith(".polaris/runs/")
  );
}

function isForeignClusterArtifact(filePath: string, activeClusterId?: string): boolean {
  if (!activeClusterId) {
    return false;
  }

  const match = /^\.polaris\/clusters\/([^/]+)\//.exec(filePath);
  return Boolean(match && match[1] !== activeClusterId);
}

function formatPathList(paths: readonly string[]): string {
  return paths.map((filePath) => ` - ${filePath}`).join("\n");
}

function runStagedArtifactPreflight(repoRoot: string, options: RunChecksOptions): void {
  if (options.skipDelivery) {
    console.log("[4/13] Skipping staged delivery artifact check (--skip-delivery).");
    return;
  }

  const stagedPaths = getStagedPaths(repoRoot);
  if (stagedPaths.length === 0) {
    return;
  }

  const blockedPaths = stagedPaths.filter(isBlockedDeliveryPath);
  const foreignClusterPaths = stagedPaths.filter((filePath) =>
    isForeignClusterArtifact(filePath, options.activeClusterId)
  );

  if (foreignClusterPaths.length > 0) {
    console.warn(
      [
        "finalize warning: staged artifacts from other clusters detected:",
        formatPathList(foreignClusterPaths),
        `Corrective action: keep only active cluster ${options.activeClusterId ?? "<unknown>"} artifacts staged for delivery, or unstage these paths with 'git restore --staged <path>'.`,
      ].join("\n"),
    );
  }

  if (blockedPaths.length > 0) {
    process.stderr.write(
      [
        "finalize aborted: staged delivery-blocked paths detected:",
        formatPathList(blockedPaths),
        "Corrective action: unstage these paths with 'git restore --staged <path>' (or remove them) before rerunning finalize delivery.",
      ].join("\n") + "\n",
    );
    process.exit(1);
  }
}

export function stepRunChecks(repoRoot: string, checks: string[], options: RunChecksOptions = {}): void {
  for (const check of checks) {
    const argv = parseShellArgs(check);
    const cmd = argv[0];
    if (!cmd) continue;
    const args = argv.slice(1);
    const result = spawnSync(cmd, args, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "inherit",
      shell: false,
    });
    if (result.status !== 0) {
      process.stderr.write(`finalize aborted: check failed: ${check}\n`);
      process.exit(1);
    }
  }

  runStagedArtifactPreflight(repoRoot, options);
}
