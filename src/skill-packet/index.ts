import { Command } from "commander";
import { loadConfig } from "../config/loader.js";
import { generateSkillPacket, SUPPORTED_SKILLS } from "./generator.js";
import type { SkillName } from "./types.js";

export interface SkillPacketOptions {
  repoRoot: string;
}

export function createSkillCommand(options: SkillPacketOptions): Command {
  const command = new Command("skill")
    .description("safe/read-only: skill packet operations")
    .showHelpAfterError()
    .action(() => {
      command.outputHelp();
    });

  const packetCommand = new Command("packet")
    .description(
      "safe/read-only: generate a Polaris skill packet for the given skill. " +
      "Any documents produced during the session must be placed in smartdocs/raw/ first — never written directly to active tiers.",
    )
    .argument("<skill-name>", `skill to generate a packet for (${SUPPORTED_SKILLS.join(", ")})`)
    .action((skillName: string) => {
      if (!SUPPORTED_SKILLS.includes(skillName as SkillName)) {
        process.stderr.write(
          `Unknown skill: ${skillName}\nSupported skills: ${SUPPORTED_SKILLS.join(", ")}\n`,
        );
        process.exit(1);
      }

      const config = loadConfig(options.repoRoot);
      const skillPacketConfig = config.skill_packet ?? {
        analysis_confidence_threshold: 85,
        auto_deep_analysis: false,
        allow_cross_provider_delegation: false,
      };

      const packet = generateSkillPacket(skillName as SkillName, {
        analysis_confidence_threshold:
          skillPacketConfig.analysis_confidence_threshold ?? 85,
        auto_deep_analysis: skillPacketConfig.auto_deep_analysis ?? false,
        allow_cross_provider_delegation:
          skillPacketConfig.allow_cross_provider_delegation ?? false,
      });

      process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    });

  command.addCommand(packetCommand);

  return command;
}
