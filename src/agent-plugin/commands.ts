import type { SkillName } from "../skill-packet/types.js";

/**
 * Neutral slash-command manifest for `/polaris-*` intent shortcuts.
 *
 * This manifest is host-agnostic: it declares each verb, whether it resolves to a
 * Polaris skill packet (via SUPPORTED_SKILLS) or delegates to an existing CLI
 * command, and the argument spec for that verb. Host-specific shim generators
 * (e.g., Claude Code) consume this manifest and emit their own plugin files.
 */

export interface SlashCommandArg {
  name: string;
  required: boolean;
  description: string;
}

export interface SkillSlashCommand {
  name: string;
  kind: "skill";
  skill: SkillName;
  /** Path to the routing document that resolves the verb to a skill packet path. */
  routing: string;
  args: SlashCommandArg[];
  description: string;
}

export interface CliSlashCommand {
  name: string;
  kind: "cli";
  command: string;
  args: SlashCommandArg[];
  description: string;
}

export type SlashCommand = SkillSlashCommand | CliSlashCommand;

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "polaris-run",
    kind: "skill",
    skill: "run",
    routing: ".polaris/skills/ROUTING.md",
    args: [
      {
        name: "cluster_id",
        required: true,
        description: "Cluster ID to execute (e.g., POL-257)",
      },
    ],
    description: "Execute a Polaris run cluster via the Foreman skill packet",
  },
  {
    name: "polaris-analyze",
    kind: "skill",
    skill: "analyze",
    routing: ".polaris/skills/ROUTING.md",
    args: [
      {
        name: "cluster_id",
        required: true,
        description: "Cluster ID to analyze (e.g., POL-257)",
      },
    ],
    description: "Analyze a cluster and produce an implementation plan via the Analyst skill packet",
  },
  {
    name: "polaris-init",
    kind: "cli",
    command: "polaris init",
    args: [],
    description: "Initialize a new Polaris workspace",
  },
  {
    name: "polaris-adopt",
    kind: "cli",
    command: "polaris adopt",
    args: [],
    description: "Adopt Polaris into an existing repository",
  },
  {
    name: "polaris-reconcile",
    kind: "skill",
    skill: "triage",
    routing: ".polaris/skills/ROUTING.md",
    args: [
      {
        name: "target",
        required: true,
        description: "Reconciliation target (e.g., smartdocs or a cluster ID)",
      },
    ],
    description: "Reconcile project cognition via the triage skill packet",
  },
  {
    name: "polaris-status",
    kind: "cli",
    command: "polaris status",
    args: [],
    description: "Print the current Polaris loop run state summary",
  },
];

export const SLASH_COMMAND_BY_NAME: Record<string, SlashCommand> = Object.fromEntries(
  SLASH_COMMANDS.map((command) => [command.name, command]),
);

export function resolveSlashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMAND_BY_NAME[name];
}
