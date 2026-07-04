import { describe, expect, it } from "vitest";
import { resolveSlashCommand, SLASH_COMMANDS, SLASH_COMMAND_BY_NAME } from "./commands.js";
import { SUPPORTED_SKILLS } from "../skill-packet/generator.js";

describe("slash-command manifest", () => {
  const expectedNames = [
    "polaris-run",
    "polaris-analyze",
    "polaris-finalize",
    "polaris-init",
    "polaris-adopt",
    "polaris-reconcile",
    "polaris-catalog",
    "polaris-status",
    "docs-ingest",
    "docs-promote",
  ];

  it("covers routed Polaris commands and setup/status helpers", () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual(expectedNames);
  });

  it("exposes a lookup by command name", () => {
    for (const name of expectedNames) {
      expect(SLASH_COMMAND_BY_NAME[name]).toBeDefined();
      expect(resolveSlashCommand(name)?.name).toBe(name);
    }
  });

  it("resolves skill-backed verbs to valid SUPPORTED_SKILLS names", () => {
    const skillCommands = SLASH_COMMANDS.filter((command) => command.kind === "skill");
    expect(skillCommands.length).toBeGreaterThan(0);
    for (const command of skillCommands) {
      expect(SUPPORTED_SKILLS).toContain(command.skill);
    }
  });

  it("delegates intent verbs to real CLI commands", () => {
    const cliCommands = SLASH_COMMANDS.filter((command) => command.kind === "cli");
    expect(cliCommands.map((command) => command.command)).toEqual([
      "polaris init",
      "polaris adopt",
      "polaris status",
    ]);
  });

  it("declares arg names and arity per verb", () => {
    expect(SLASH_COMMANDS.find((command) => command.name === "polaris-run")?.args).toEqual([
      { name: "cluster_id", required: true, description: expect.any(String) },
    ]);
    expect(SLASH_COMMANDS.find((command) => command.name === "polaris-analyze")?.args).toEqual([
      { name: "cluster_id", required: true, description: expect.any(String) },
    ]);
    expect(SLASH_COMMANDS.find((command) => command.name === "polaris-reconcile")?.args).toEqual([
      { name: "target", required: true, description: expect.any(String) },
    ]);
    expect(SLASH_COMMANDS.find((command) => command.name === "polaris-catalog")?.args).toEqual([
      { name: "cluster_id", required: true, description: expect.any(String) },
    ]);

    for (const name of ["polaris-init", "polaris-adopt", "polaris-status"]) {
      const command = SLASH_COMMANDS.find((candidate) => candidate.name === name);
      expect(command?.args).toEqual([]);
    }
  });

  it("maps skill-backed verbs to canonical Polaris skill directories", () => {
    const skillTargets = Object.fromEntries(
      SLASH_COMMANDS.filter((command) => command.kind === "skill").map((command) => [
        command.name,
        command.targetSkill,
      ]),
    );

    expect(skillTargets).toEqual({
      "polaris-run": "polaris-run",
      "polaris-analyze": "polaris-analyze",
      "polaris-finalize": "polaris-run",
      "polaris-reconcile": "polaris-reconcile",
      "polaris-catalog": "polaris-catalog",
      "docs-ingest": "docs-ingest",
      "docs-promote": "docs-promote",
    });
  });
});
