import { spawnSync } from "node:child_process";
import { join } from "node:path";

export class InvokeError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "InvokeError";
  }
}

export function invokePolarisJson(repoRoot: string, args: string[]): unknown {
  const result = spawnSync("node", [join("dist", "cli", "index.js"), ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 10_000,
    shell: false,
  });

  if (result.error) {
    throw new InvokeError(`Subprocess error: ${result.error.message}`, "");
  }
  if (result.status !== 0) {
    throw new InvokeError(
      `polaris exited with status ${result.status ?? "null"}`,
      result.stderr ?? "",
    );
  }

  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new InvokeError("Failed to parse subprocess JSON output", result.stderr ?? "");
  }
}
