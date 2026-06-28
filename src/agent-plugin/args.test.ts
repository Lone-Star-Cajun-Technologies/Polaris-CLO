import { describe, expect, it } from "vitest";
import type { SlashCommand } from "./commands.js";
import { validateSlashCommandArgs } from "./args.js";

describe("validateSlashCommandArgs", () => {
  const runCommand: SlashCommand = {
    name: "polaris-run",
    kind: "skill",
    skill: "run",
    routing: ".polaris/skills/ROUTING.md",
    args: [
      {
        name: "cluster_id",
        required: true,
        description: "Cluster ID to execute",
      },
    ],
    description: "Run a cluster",
  };

  const initCommand: SlashCommand = {
    name: "polaris-init",
    kind: "cli",
    command: "polaris init",
    args: [],
    description: "Initialize Polaris",
  };

  it("returns help request when --help is passed", () => {
    const result = validateSlashCommandArgs(runCommand, ["POL-123", "--help"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.help).toBe(true);
      expect(result.value.positional).toEqual([]);
    }
  });

  it("returns help request when -h is passed", () => {
    const result = validateSlashCommandArgs(runCommand, ["-h"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.help).toBe(true);
    }
  });

  it("passes through valid required positional arguments", () => {
    const result = validateSlashCommandArgs(runCommand, ["POL-123"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.help).toBe(false);
      expect(result.value.positional).toEqual(["POL-123"]);
    }
  });

  it("rejects missing required arguments with arity error", () => {
    const result = validateSlashCommandArgs(runCommand, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("arity");
      expect(result.error.message).toContain("requires 1 positional argument");
    }
  });

  it("rejects too many positional arguments with arity error", () => {
    const result = validateSlashCommandArgs(runCommand, ["POL-123", "extra"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("arity");
      expect(result.error.message).toContain("accepts at most 1 positional argument");
    }
  });

  it("allows no arguments for commands with no args", () => {
    const result = validateSlashCommandArgs(initCommand, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.positional).toEqual([]);
      expect(result.value.help).toBe(false);
    }
  });

  it("rejects empty string arguments as type mismatch", () => {
    const result = validateSlashCommandArgs(runCommand, [""]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("type");
    }
  });

  it("ignores dash-prefixed tokens when counting positional args", () => {
    const result = validateSlashCommandArgs(runCommand, ["--foo", "POL-123"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.positional).toEqual(["POL-123"]);
    }
  });

  it("validates typed identifiers when declared", () => {
    const typedCommand: SlashCommand = {
      name: "polaris-typed",
      kind: "cli",
      command: "polaris typed",
      args: [
        {
          name: "id",
          required: true,
          description: "Identifier",
          type: "identifier",
        } as any,
      ],
      description: "Typed command",
    };

    const bad = validateSlashCommandArgs(typedCommand, ["bad id!"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.kind).toBe("type");
    }

    const good = validateSlashCommandArgs(typedCommand, ["good-id_123"]);
    expect(good.ok).toBe(true);
  });
});
