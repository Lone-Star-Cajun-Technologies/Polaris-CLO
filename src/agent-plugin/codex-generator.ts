import * as fs from "fs";
import * as path from "path";
import { SLASH_COMMANDS, type SkillSlashCommand } from "./commands.js";

export const CODEX_PLUGIN_SKILL_VERSION = "1";

function skillCommands(): SkillSlashCommand[] {
  return SLASH_COMMANDS.filter((command): command is SkillSlashCommand => command.kind === "skill");
}

function renderArgs(command: SkillSlashCommand): string {
  if (command.args.length === 0) return "None.";
  return command.args
    .map((arg) => `- \`${arg.name}\`${arg.required ? " (required)" : " (optional)"} - ${arg.description}`)
    .join("\n");
}

function renderUsage(command: SkillSlashCommand): string {
  const argUsage = command.args
    .map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
    .join(" ");
  return argUsage ? `${command.name} ${argUsage}` : command.name;
}

function renderBootloaderArgs(command: SkillSlashCommand): string {
  const argUsage = command.args
    .map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
    .join(" ");
  return argUsage ? ` ${argUsage}` : "";
}

export function generateCodexPluginSkill(command: SkillSlashCommand): string {
  return `---
name: ${command.name}
description: ${command.description}
---
<!-- polaris-codex-skill-version: ${CODEX_PLUGIN_SKILL_VERSION} -->

# ${command.name}

${command.description}

This Codex plugin skill is a thin wrapper around the canonical Polaris skill. It does not implement a parallel runtime.

## Usage

\`\`\`text
${renderUsage(command)}
\`\`\`

## Arguments

${renderArgs(command)}

## Mandatory Routing

1. Read \`${command.routing}\` and resolve \`${command.name}\` to its target skill.
2. Read \`.polaris/skills/${command.targetSkill}/SKILL.md\` before any repo inspection, tracker lookup, or runtime file reads.
3. Run the skill bootloader from that canonical \`SKILL.md\`:
   \`\`\`bash
   polaris skill packet ${command.skill}${renderBootloaderArgs(command)}
   \`\`\`
4. If no packet is returned, stop and report: \`Blocking: Polaris could not authorize this run.\`
5. Execute \`.polaris/skills/${command.targetSkill}/chain.md\` in strict step order.

If \`.polaris/skills/${command.targetSkill}/SKILL.md\` is missing, stop and report:
\`Blocking: skill packet not found at .polaris/skills/${command.targetSkill}/SKILL.md\`
`;
}

export function generateCodexOpenAiYaml(command: SkillSlashCommand): string {
  const displayName = command.name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return `interface:
  display_name: "${displayName}"
  short_description: "${command.description.replaceAll('"', '\\"')}"
  brand_color: "#6366F1"
  default_prompt: "Use $${command.name} to ${command.description.charAt(0).toLowerCase()}${command.description.slice(1)}."
`;
}

export function generateAllCodexPluginSkills(outDir: string = ".codex/plugins/polaris/skills"): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  for (const command of skillCommands()) {
    const skillDir = path.join(outDir, command.name);
    const agentsDir = path.join(skillDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });

    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillPath, generateCodexPluginSkill(command), "utf8");
    written.push(skillPath);

    const yamlPath = path.join(agentsDir, "openai.yaml");
    fs.writeFileSync(yamlPath, generateCodexOpenAiYaml(command), "utf8");
    written.push(yamlPath);
  }

  return written;
}
