import { spawnSync } from "node:child_process";

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

export function stepRunChecks(repoRoot: string, checks: string[]): void {
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
}
