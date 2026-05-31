import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createSkillCommand } from "./index.js";

vi.mock("../config/loader.js", () => ({
  loadConfig: () => ({
    skill_packet: {
      analysis_confidence_threshold: 85,
      auto_deep_analysis: false,
      allow_cross_provider_delegation: false,
    },
  }),
}));

function configureForTest(program: Command, output: { stdout: string; stderr: string }) {
  program.exitOverride();
  program.configureOutput({
    writeOut: (value) => {
      output.stdout += value;
    },
    writeErr: (value) => {
      output.stderr += value;
    },
  });
  for (const command of program.commands) {
    configureForTest(command, output);
  }
}

async function runSkillCommand(argv: string[]) {
  const output = { stdout: "", stderr: "" };
  let exitCode = 0;
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.stdout += String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.stderr += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error(`process.exit(${code})`);
  });

  const command = createSkillCommand({ repoRoot: "/repo" });
  configureForTest(command, output);

  try {
    await command.parseAsync(["node", "polaris-skill", ...argv], { from: "node" });
  } catch (error) {
    if (error instanceof Error && "exitCode" in error) {
      exitCode = Number(error.exitCode);
    } else if (error instanceof Error && error.message.startsWith("process.exit(")) {
      // swallow process.exit mock throws
    } else {
      throw error;
    }
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { ...output, exitCode };
}

describe("polaris skill packet CLI", () => {
  it("prints skill help when no subcommand is given", async () => {
    const result = await runSkillCommand(["--help"]);
    expect(result.stdout).toContain("skill packet");
  });

  it.each(["analyze", "run", "ingest", "promote"])(
    "generates a valid JSON packet for %s",
    async (skill) => {
      const result = await runSkillCommand(["packet", skill]);
      const packet = JSON.parse(result.stdout) as Record<string, unknown>;

      expect(packet.skill_name).toBe(skill);
      expect(typeof packet.packet_id).toBe("string");
      expect(typeof packet.active_role).toBe("string");
      expect(typeof packet.role_summary).toBe("string");
      expect(Array.isArray(packet.authority_boundaries)).toBe(true);
      expect(Array.isArray(packet.prohibited_actions)).toBe(true);
      expect(Array.isArray(packet.allowed_outputs)).toBe(true);
      expect(Array.isArray(packet.deliverables)).toBe(true);
      expect(Array.isArray(packet.stop_conditions)).toBe(true);
      expect(typeof packet.generated_at).toBe("string");
    },
  );

  it("writes error and exits for unknown skill", async () => {
    const result = await runSkillCommand(["packet", "unknown-skill"]);
    expect(result.stderr).toContain("Unknown skill");
    expect(result.stderr).toContain("analyze");
    expect(result.exitCode).toBe(1);
  });

  it("analyze packet includes confidence_policy", async () => {
    const result = await runSkillCommand(["packet", "analyze"]);
    const packet = JSON.parse(result.stdout) as Record<string, unknown>;
    const policy = packet.confidence_policy as Record<string, unknown>;
    expect(policy).toBeDefined();
    expect(policy.threshold).toBe(85);
    expect(policy.auto_deep_analysis).toBe(false);
    expect(policy.on_below_threshold).toBe("ask_user");
  });

  it("run packet does not include confidence_policy", async () => {
    const result = await runSkillCommand(["packet", "run"]);
    const packet = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(packet.confidence_policy).toBeUndefined();
  });
});
