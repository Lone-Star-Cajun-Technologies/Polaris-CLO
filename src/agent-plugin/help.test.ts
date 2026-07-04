import { describe, expect, it } from "vitest";
import type { SlashCommand } from "./commands.js";
import { generateErrorMessage, generateHelp, generateUsage, generateResponse } from "./help.js";
import { validateSlashCommandArgs } from "./args.js";

describe("generateUsage", () => {
  it("formats required args as <name> and optional as [name]", () => {
    const command: SlashCommand = {
      name: "polaris-test",
      kind: "cli",
      command: "polaris test",
      args: [
        { name: "a", required: true, description: "A" },
        { name: "b", required: false, description: "B" },
      ],
      description: "Test",
    };
    expect(generateUsage(command)).toBe("/polaris-test <a> [b]");
  });

  it("returns bare command when no args", () => {
    const command: SlashCommand = {
      name: "polaris-init",
      kind: "cli",
      command: "polaris init",
      args: [],
      description: "Init",
    };
    expect(generateUsage(command)).toBe("/polaris-init");
  });
});

describe("generateHelp", () => {
  const command: SlashCommand = {
    name: "polaris-run",
    kind: "skill",
    skill: "run",
    targetSkill: "polaris-run",
    routing: ".polaris/skills/ROUTING.md",
    args: [{ name: "cluster_id", required: true, description: "Cluster ID" }],
    description: "Run a cluster",
  };

  it("includes the command name and description", () => {
    const help = generateHelp(command);
    expect(help).toContain("/polaris-run");
    expect(help).toContain("Run a cluster");
  });

  it("includes the usage block", () => {
    const help = generateHelp(command);
    expect(help).toContain("/polaris-run <cluster_id>");
  });

  it("includes the argument list", () => {
    const help = generateHelp(command);
    expect(help).toContain("cluster_id");
    expect(help).toContain("required");
  });

  it("includes help flag instructions", () => {
    const help = generateHelp(command);
    expect(help).toContain("--help");
    expect(help).toContain("-h");
  });

  it("lists 'None.' for commands without args", () => {
    const noArgs: SlashCommand = {
      name: "polaris-init",
      kind: "cli",
      command: "polaris init",
      args: [],
      description: "Initialize",
    };
    const help = generateHelp(noArgs);
    expect(help).toContain("None.");
  });
});

describe("generateErrorMessage", () => {
  const command: SlashCommand = {
    name: "polaris-run",
    kind: "skill",
    skill: "run",
    targetSkill: "polaris-run",
    routing: ".polaris/skills/ROUTING.md",
    args: [{ name: "cluster_id", required: true, description: "Cluster ID" }],
    description: "Run a cluster",
  };

  it("includes the error message and the help block", () => {
    const message = generateErrorMessage(command, {
      kind: "arity",
      message: "Missing cluster_id",
    });
    expect(message).toContain("Error: Missing cluster_id");
    expect(message).toContain("/polaris-run");
    expect(message).toContain("Usage:");
  });
});

describe("generateResponse", () => {
  const command: SlashCommand = {
    name: "polaris-run",
    kind: "skill",
    skill: "run",
    targetSkill: "polaris-run",
    routing: ".polaris/skills/ROUTING.md",
    args: [{ name: "cluster_id", required: true, description: "Cluster ID" }],
    description: "Run a cluster",
  };

  it("returns help text for a help request", () => {
    const validated = validateSlashCommandArgs(command, ["--help"]);
    const response = generateResponse(command, validated);
    expect(response).toContain("/polaris-run");
  });

  it("returns error text for an invalid input", () => {
    const validated = validateSlashCommandArgs(command, []);
    const response = generateResponse(command, validated);
    expect(response).toContain("Error:");
  });

  it("returns null for valid input", () => {
    const validated = validateSlashCommandArgs(command, ["POL-123"]);
    const response = generateResponse(command, validated);
    expect(response).toBeNull();
  });
});
