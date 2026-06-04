export interface CliArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseCliArgs(argv: string[]): CliArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  return { flags, positional };
}

export function parseSpecPathFromPositional(positional: string[]): string | null {
  if (positional.length < 2) {
    return null;
  }
  return positional[0] === "spec" ? positional[1] : null;
}
