import * as fs from "fs";
import * as path from "path";
import { SLASH_COMMANDS, type SlashCommand } from "./commands.js";

/**
 * Host-specific shim generator for Claude Code (.claude/commands/).
 *
 * Reads the neutral SLASH_COMMANDS manifest and writes one
 * `.claude/commands/polaris-<verb>.md` file per verb.
 *
 * Skill-backed verbs route through the existing packet+chain path:
 *   1. Read .polaris/skills/<skill>/SKILL.md
 *   2. Run `polaris skill packet <skill>`
 *   3. Execute the chain
 *
 * CLI-backed verbs delegate directly to the real CLI command.
 *
 * Version stamp: each shim carries a `<!-- polaris-shim-version: <version> -->` comment
 * so the sync command (child 4) can detect drift.
 */

/** Version string baked into every generated shim. */
export const SHIM_VERSION = "1";

/**
 * Generate the markdown body for a Claude Code slash-command shim.
 * Host specifics are isolated here; the manifest itself is neutral.
 */
export function generateClaudeShim(command: SlashCommand): string {
  const argUsage =
    command.args.length > 0
      ? command.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ")
      : "";
  const usage = argUsage ? `/${command.name} ${argUsage}` : `/${command.name}`;

  if (command.kind === "skill") {
    const argLines =
      command.args.length > 0
        ? command.args
            .map(
              (a) =>
                `- \`${a.name}\`${a.required ? " (required)" : " (optional)"} — ${a.description}`,
            )
            .join("\n")
        : "None.";

    return `<!-- polaris-shim-version: ${SHIM_VERSION} -->
# /${command.name}

${command.description}

## Usage

\`\`\`text
${usage}
\`\`\`

## Arguments

${argLines}

## Routing

This slash command is a shim around the **${command.skill}** Polaris skill packet.
It does not implement a parallel runtime — it routes through the existing packet+chain path.

See \`${command.routing}\` for the full routing protocol and skill directory resolution.

## Execution

1. Look up \`/${command.name}\` in \`${command.routing}\` to find the target skill directory.
2. Read \`.polaris/skills/<target-skill>/SKILL.md\` — it is the authoritative instruction source.
3. Run the skill bootloader:
   \`\`\`bash
   polaris skill packet ${command.skill}${command.args.length > 0 ? " $ARGUMENTS" : ""}
   \`\`\`
   Do not begin work until a packet is returned.
   If no packet is produced, stop and report: **Polaris could not authorize this run.**
4. Execute the chain as instructed in the packet.
`;
  }

  // CLI-backed command
  const argLines =
    command.args.length > 0
      ? command.args
          .map(
            (a) =>
              `- \`${a.name}\`${a.required ? " (required)" : " (optional)"} — ${a.description}`,
          )
          .join("\n")
      : "None.";

  return `<!-- polaris-shim-version: ${SHIM_VERSION} -->
# /${command.name}

${command.description}

## Usage

\`\`\`text
${usage}
\`\`\`

## Arguments

${argLines}

## Execution

Run the following CLI command:

\`\`\`bash
${command.command}
\`\`\`
`;
}

/**
 * Write all Claude Code shim files to `outDir` (default: `.claude/commands`).
 * Creates the directory if it does not exist.
 * Returns the list of files written.
 */
export function generateAllClaudeShims(outDir: string = ".claude/commands"): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const seen = new Set<string>();
  for (const command of SLASH_COMMANDS) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    const filePath = path.join(outDir, `${command.name}.md`);
    fs.writeFileSync(filePath, generateClaudeShim(command), "utf8");
    written.push(filePath);
  }
  return written;
}
