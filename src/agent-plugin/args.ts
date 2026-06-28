import type { SlashCommand, SlashCommandArg } from "./commands.js";

/**
 * Argument validation for slash-command invocations.
 *
 * Validates a parsed argv list against the manifest's arg spec for a verb.
 * Rejects arity mismatches and malformed positional values before any
 * packet or CLI command is resolved. Help flags are surfaced separately so
 * callers can generate help output without invoking the command.
 */

export interface ArgError {
  kind: "arity" | "type";
  message: string;
}

export interface SlashCommandInput {
  command: SlashCommand;
  /** Positional arguments after validation. */
  positional: string[];
  /** True if the user explicitly asked for help output. */
  help: boolean;
}

export type SlashCommandResult =
  | { ok: true; value: SlashCommandInput }
  | { ok: false; error: ArgError };

/**
 * Validate positional arguments against the command's declared arg spec.
 *
 * Rules:
 * - `--help` / `-h` anywhere in argv returns a help request (no validation).
 * - Required positional arguments must be present.
 * - No more positional arguments than declared are accepted.
 * - Empty strings are treated as a type mismatch.
 */
export function validateSlashCommandArgs(
  command: SlashCommand,
  argv: string[] = [],
): SlashCommandResult {
  const help = argv.includes("--help") || argv.includes("-h");
  if (help) {
    return { ok: true, value: { command, positional: [], help: true } };
  }

  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const requiredCount = command.args.filter((arg) => arg.required).length;
  const maxCount = command.args.length;

  if (positional.length < requiredCount) {
    return {
      ok: false,
      error: {
        kind: "arity",
        message: `/${command.name} requires ${requiredCount} positional argument(s) but received ${positional.length}.`,
      },
    };
  }

  if (positional.length > maxCount) {
    return {
      ok: false,
      error: {
        kind: "arity",
        message: `/${command.name} accepts at most ${maxCount} positional argument(s) but received ${positional.length}.`,
      },
    };
  }

  for (const value of positional) {
    if (value.trim() === "") {
      return {
        ok: false,
        error: {
          kind: "type",
          message: `Arguments to /${command.name} must be non-empty strings.`,
        },
      };
    }
  }

  // ponytail: support optional typed args (e.g. number, enum) when the manifest
  // adds a `type` field; for now only string/empty-string checks are required.
  if (hasTypedArgs(command.args)) {
    for (let i = 0; i < positional.length; i++) {
      const arg = command.args[i];
      const value = positional[i];
      if (arg.type && !validateArgType(value, arg.type)) {
        return {
          ok: false,
          error: {
            kind: "type",
            message: `Argument \`${arg.name}\` for /${command.name} must be a valid ${arg.type}.`,
          },
        };
      }
    }
  }

  return { ok: true, value: { command, positional, help: false } };
}

/** Extended arg spec used internally when the manifest declares a type. */
interface TypedSlashCommandArg extends SlashCommandArg {
  type?: "string" | "identifier";
}

function hasTypedArgs(args: SlashCommandArg[]): args is TypedSlashCommandArg[] {
  return args.some((arg) => (arg as TypedSlashCommandArg).type !== undefined);
}

function validateArgType(value: string, type: "string" | "identifier"): boolean {
  if (type === "identifier") {
    return /^[A-Za-z0-9_-]+$/.test(value);
  }
  return true;
}
