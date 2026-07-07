import { describe, expect, it } from "vitest";
import { createAutoresearchCommand } from "./autoresearch.js";

describe("createAutoresearchCommand", () => {
  it("returns a command with 'score' and 'propose' subcommands", () => {
    const command = createAutoresearchCommand({ repoRoot: "/tmp/polaris-test" });
    const subcommands = command.commands.map((c) => c.name());
    expect(subcommands).toContain("score");
    expect(subcommands).toContain("propose");
  });

  it("exposes the configured repo root as the default", () => {
    const command = createAutoresearchCommand({ repoRoot: "/custom/root" });
    const score = command.commands.find((c) => c.name() === "score");
    expect(score).toBeDefined();
    expect(score!.opts().repoRoot).toBe("/custom/root");
  });
});
