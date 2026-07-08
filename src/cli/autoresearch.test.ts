import { describe, expect, it } from "vitest";
import { createSolCommand, createAutoresearchCommand } from "./autoresearch.js";

describe("createSolCommand", () => {
  it("returns a 'sol' command with 'score' and 'propose' subcommands", () => {
    const command = createSolCommand({ repoRoot: "/tmp/polaris-test" });
    expect(command.name()).toBe("sol");
    const subcommands = command.commands.map((c) => c.name());
    expect(subcommands).toContain("score");
    expect(subcommands).toContain("propose");
  });

  it("exposes the configured repo root as the default", () => {
    const command = createSolCommand({ repoRoot: "/custom/root" });
    const score = command.commands.find((c) => c.name() === "score");
    expect(score).toBeDefined();
    expect(score!.opts().repoRoot).toBe("/custom/root");
  });

  it("keeps 'autoresearch' as a compatibility alias", () => {
    const command = createSolCommand({ repoRoot: "/tmp/polaris-test" });
    expect(command.alias()).toBe("autoresearch");
  });
});

describe("createAutoresearchCommand", () => {
  it("remains an alias for createSolCommand", () => {
    const command = createAutoresearchCommand({ repoRoot: "/tmp/polaris-test" });
    expect(command.name()).toBe("sol");
    expect(command.alias()).toBe("autoresearch");
  });
});
