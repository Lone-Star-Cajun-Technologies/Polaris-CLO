import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "./commands.js";
import {
  CODEX_PLUGIN_SKILL_VERSION,
  generateAllCodexPluginSkills,
  generateCodexOpenAiYaml,
  generateCodexPluginSkill,
} from "./codex-generator.js";

describe("generateCodexPluginSkill", () => {
  it("generates a thin plugin wrapper for polaris-run", () => {
    const command = SLASH_COMMANDS.find((candidate) => candidate.name === "polaris-run")!;
    if (command.kind !== "skill") throw new Error("expected skill command");

    const skill = generateCodexPluginSkill(command);
    expect(skill).toContain(`<!-- polaris-codex-skill-version: ${CODEX_PLUGIN_SKILL_VERSION} -->`);
    expect(skill).toContain("name: polaris-run");
    expect(skill).toContain(".polaris/skills/ROUTING.md");
    expect(skill).toContain(".polaris/skills/polaris-run/SKILL.md");
    expect(skill).toContain("polaris skill packet run <cluster_id>");
    expect(skill).toContain("Blocking: Polaris could not authorize this run.");
  });

  it("routes polaris-finalize through the canonical polaris-run skill", () => {
    const command = SLASH_COMMANDS.find((candidate) => candidate.name === "polaris-finalize")!;
    if (command.kind !== "skill") throw new Error("expected skill command");

    const skill = generateCodexPluginSkill(command);
    expect(skill).toContain("name: polaris-finalize");
    expect(skill).toContain(".polaris/skills/polaris-run/SKILL.md");
    expect(skill).toContain("polaris skill packet run");
  });

  it("generates OpenAI metadata for plugin discovery", () => {
    const command = SLASH_COMMANDS.find((candidate) => candidate.name === "docs-ingest")!;
    if (command.kind !== "skill") throw new Error("expected skill command");

    const yaml = generateCodexOpenAiYaml(command);
    expect(yaml).toContain('display_name: "Docs Ingest"');
    expect(yaml).toContain("default_prompt:");
    expect(yaml).toContain("$docs-ingest");
  });
});

describe("generateAllCodexPluginSkills", () => {
  it("writes SKILL.md and openai.yaml for every skill-backed manifest command", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-codex-plugin-test-"));
    try {
      const written = generateAllCodexPluginSkills(tmpDir);
      const skillCommands = SLASH_COMMANDS.filter((command) => command.kind === "skill");

      expect(written).toHaveLength(skillCommands.length * 2);
      for (const command of skillCommands) {
        expect(fs.existsSync(path.join(tmpDir, command.name, "SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, command.name, "agents", "openai.yaml"))).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
