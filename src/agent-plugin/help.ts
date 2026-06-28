import type { SlashCommand } from "./commands.js";
import type { ArgError } from "./args.js";

/**
 * Help and error-message generation for slash-command invocations.
 *
 * Produces `--help`-style output directly from the neutral manifest so the
 * same text can be used by any host shim. Error messages include the same
 * help block so users see both the failure and the correct usage.
 */

/**
 * Build a usage line from the command's arg spec.
 * Required args are shown as `<name>`; optional as `[name]`.
 */
export function generateUsage(command: SlashCommand): string {
  const argUsage = command.args
    .map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
    .join(" ");
  return argUsage ? `/${command.name} ${argUsage}` : `/${command.name}`;
}

/**
 * Generate `--help`-style output for a single manifest verb.
 */
export function generateHelp(command: SlashCommand): string {
  const argLines =
    command.args.length > 0
      ? command.args
          .map(
            (arg) =>
              `- \`${arg.name}\`${arg.required ? " (required)" : " (optional)"} — ${arg.description}`,
          )
          .join("\n")
      : "None.";

  return `/${command.name}

${command.description}

Usage:

\`\`\`
${generateUsage(command)}
\`\`\`

Arguments:

${argLines}

Use \`--help\` or \`-h\` to show this message.`;
}

/**
 * Generate an error message that includes the command's help block.
 */
export function generateErrorMessage(
  command: SlashCommand,
  error: ArgError,
): string {
  return `Error: ${error.message}

${generateHelp(command)}`;
}

/**
 * Convenience helper that returns the rendered message for a validation result.
 * Returns `null` when the input is valid and no help/error text is needed.
 */
export function generateResponse(
  command: SlashCommand,
  result: { ok: true; value: { help: boolean } } | { ok: false; error: ArgError },
): string | null {
  if (!result.ok) {
    return generateErrorMessage(command, result.error);
  }
  if (result.value.help) {
    return generateHelp(command);
  }
  return null;
}
