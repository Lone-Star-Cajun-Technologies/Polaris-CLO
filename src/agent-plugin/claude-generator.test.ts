import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "./commands.js";
import { generateAllClaudeShims, generateClaudeShim, SHIM_VERSION } from "./claude-generator.js";

describe("generateClaudeShim", () => {
  it("produces a skill shim for polaris-run with version stamp", () => {
    const command = SLASH_COMMANDS.find((c) => c.name === "polaris-run")!;
    const shim = generateClaudeShim(command);
    expect(shim).toContain(`<!-- polaris-shim-version: ${SHIM_VERSION} -->`);
    expect(shim).toContain("polaris skill packet run");
    expect(shim).toContain(".polaris/skills/ROUTING.md");
    expect(shim).toContain("/polaris-run");
    // Shim references the routing table for directory resolution, not a hardcoded path
    expect(shim).toContain("target-skill");
  });

  it("produces a skill shim for polaris-analyze with bootloader instruction", () => {
    const command = SLASH_COMMANDS.find((c) => c.name === "polaris-analyze")!;
    const shim = generateClaudeShim(command);
    expect(shim).toContain("polaris skill packet analyze");
    expect(shim).toContain("Polaris could not authorize this run");
  });

  it("produces a CLI shim for polaris-init", () => {
    const command = SLASH_COMMANDS.find((c) => c.name === "polaris-init")!;
    const shim = generateClaudeShim(command);
    expect(shim).toContain(`<!-- polaris-shim-version: ${SHIM_VERSION} -->`);
    expect(shim).toContain("polaris init");
    expect(shim).not.toContain("polaris skill packet");
  });

  it("produces a CLI shim for polaris-status", () => {
    const command = SLASH_COMMANDS.find((c) => c.name === "polaris-status")!;
    const shim = generateClaudeShim(command);
    expect(shim).toContain("polaris status");
  });

  it("skill shims do not bypass packet+chain path", () => {
    const skillCommands = SLASH_COMMANDS.filter((c) => c.kind === "skill");
    for (const command of skillCommands) {
      const shim = generateClaudeShim(command);
      expect(shim).toContain("polaris skill packet");
      // Shim must not implement routing logic itself
      expect(shim).not.toContain("polaris loop");
    }
  });

  it("includes arg documentation for commands with args", () => {
    const command = SLASH_COMMANDS.find((c) => c.name === "polaris-run")!;
    const shim = generateClaudeShim(command);
    expect(shim).toContain("cluster_id");
    expect(shim).toContain("required");
  });
});

describe("generateAllClaudeShims", () => {
  it("writes one shim per manifest verb", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-shims-test-"));
    try {
      const written = generateAllClaudeShims(tmpDir);
      expect(written).toHaveLength(SLASH_COMMANDS.length);
      for (const command of SLASH_COMMANDS) {
        const expectedPath = path.join(tmpDir, `${command.name}.md`);
        expect(written).toContain(expectedPath);
        expect(fs.existsSync(expectedPath)).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("creates the output directory if missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-shims-test-"));
    const nested = path.join(tmpDir, "does-not-exist", "commands");
    try {
      generateAllClaudeShims(nested);
      expect(fs.existsSync(nested)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("each generated shim has a version stamp", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-shims-test-"));
    try {
      const written = generateAllClaudeShims(tmpDir);
      for (const filePath of written) {
        const content = fs.readFileSync(filePath, "utf8");
        expect(content).toContain(`<!-- polaris-shim-version: ${SHIM_VERSION} -->`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
