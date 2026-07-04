import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, type SkillSlashCommand } from "./commands.js";
import { generateCodexOpenAiYaml, generateCodexPluginSkill } from "./codex-generator.js";

/**
 * These tests verify that the Codex plugin skill files checked into
 * `.codex/plugins/polaris/skills/` are in sync with what the generator in
 * `codex-generator.ts` produces for the manifest declared in `commands.ts`.
 *
 * The PR under test adds these files to the repo (docs-ingest, docs-promote,
 * polaris-analyze, polaris-catalog, polaris-finalize, polaris-reconcile,
 * polaris-run). This guards against the checked-in artifacts drifting from
 * the generator that is supposed to produce them.
 */

const SKILLS_DIR = path.join(process.cwd(), ".codex", "plugins", "polaris", "skills");

function skillCommands(): SkillSlashCommand[] {
  return SLASH_COMMANDS.filter((command): command is SkillSlashCommand => command.kind === "skill");
}

describe("checked-in Codex plugin skill artifacts", () => {
  it("has a directory under .codex/plugins/polaris/skills for every skill-backed manifest command", () => {
    for (const command of skillCommands()) {
      const skillDir = path.join(SKILLS_DIR, command.name);
      expect(fs.existsSync(skillDir), `expected skill dir for ${command.name}`).toBe(true);
      expect(fs.statSync(skillDir).isDirectory()).toBe(true);
    }
  });

  it.each(skillCommands().map((command) => [command.name, command] as const))(
    "SKILL.md for %s matches generateCodexPluginSkill output exactly",
    (_name, command) => {
      const skillPath = path.join(SKILLS_DIR, command.name, "SKILL.md");
      const actual = fs.readFileSync(skillPath, "utf8");
      const expected = generateCodexPluginSkill(command);
      expect(actual).toBe(expected);
    },
  );

  it.each(skillCommands().map((command) => [command.name, command] as const))(
    "agents/openai.yaml for %s matches generateCodexOpenAiYaml output exactly",
    (_name, command) => {
      const yamlPath = path.join(SKILLS_DIR, command.name, "agents", "openai.yaml");
      const actual = fs.readFileSync(yamlPath, "utf8");
      const expected = generateCodexOpenAiYaml(command);
      expect(actual).toBe(expected);
    },
  );

  it("does not have orphaned skill directories that no longer map to a manifest command", () => {
    const dirEntries = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    // polaris-tools is a hand-written Codex-only helper skill, not part of the
    // generated slash-command manifest, so it is excluded from this check.
    const generatedDirs = dirEntries.filter((name) => name !== "polaris-tools");
    const manifestNames = skillCommands()
      .map((command) => command.name)
      .sort();

    expect(generatedDirs.sort()).toEqual(manifestNames);
  });

  it("every generated SKILL.md references the mandatory ROUTING.md gate", () => {
    for (const command of skillCommands()) {
      const skillPath = path.join(SKILLS_DIR, command.name, "SKILL.md");
      const content = fs.readFileSync(skillPath, "utf8");
      expect(content).toContain(".polaris/skills/ROUTING.md");
      expect(content).toContain("Mandatory Routing");
      expect(content).toContain("Blocking: Polaris could not authorize this run.");
    }
  });

  it("polaris-finalize's checked-in SKILL.md routes through the canonical polaris-run skill", () => {
    const command = skillCommands().find((c) => c.name === "polaris-finalize")!;
    const skillPath = path.join(SKILLS_DIR, "polaris-finalize", "SKILL.md");
    const content = fs.readFileSync(skillPath, "utf8");

    expect(command.targetSkill).toBe("polaris-run");
    expect(content).toContain(".polaris/skills/polaris-run/SKILL.md");
    expect(content).toContain("polaris skill packet run");
    // polaris-finalize has no arguments in the manifest.
    expect(content).toContain("## Arguments\n\nNone.");
  });

  it("every generated agents/openai.yaml declares the shared Polaris brand color", () => {
    for (const command of skillCommands()) {
      const yamlPath = path.join(SKILLS_DIR, command.name, "agents", "openai.yaml");
      const content = fs.readFileSync(yamlPath, "utf8");
      expect(content).toContain('brand_color: "#6366F1"');
      expect(content).toContain(`$${command.name}`);
    }
  });
});