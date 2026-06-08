import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "./doctor.js";

let repoRoot: string | undefined;

function makeRepo(): string {
  repoRoot = mkdtempSync(join(tmpdir(), "polaris-doctor-"));
  return repoRoot;
}

beforeEach(() => {
  repoRoot = makeRepo();
});

afterEach(() => {
  if (repoRoot) {
    rmSync(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  }
});

describe("config doctor", () => {
  describe("config file checks", () => {
    it("warns when config file does not exist", () => {
      const report = runDoctor(repoRoot!);
      
      const configFileCheck = report.checks.find((c) => c.id === "config-file-exists");
      expect(configFileCheck).toBeDefined();
      expect(configFileCheck?.status).toBe("warn");
      expect(configFileCheck?.message).toContain("not found");
    });

    it("passes when config file exists and is valid JSON", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({ version: "1.0" }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const configFileCheck = report.checks.find((c) => c.id === "config-file-exists");
      expect(configFileCheck?.status).toBe("pass");
      
      const configValidationCheck = report.checks.find((c) => c.id === "config-validation");
      expect(configValidationCheck?.status).toBe("pass");
    });

    it("fails when config file is invalid JSON", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        "{ invalid json",
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const configFileCheck = report.checks.find((c) => c.id === "config-file-exists");
      expect(configFileCheck?.status).toBe("fail");
      expect(configFileCheck?.message).toContain("invalid JSON");
    });
  });

  describe("provider checks", () => {
    it("warns when no providers are configured", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({ version: "1.0" }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const providerCheck = report.checks.find((c) => c.id === "provider-config");
      expect(providerCheck).toBeDefined();
      expect(providerCheck?.status).toBe("warn");
      expect(providerCheck?.message).toContain("No external providers configured");
    });

    it("passes when providers are configured with valid commands", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({
          version: "1.0",
          execution: {
            adapter: "terminal-cli",
            providers: {
              codex: { command: "codex" },
              gemini: { command: "gemini" },
            },
          },
        }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const providerCheck = report.checks.find((c) => c.id === "provider-config");
      expect(providerCheck?.status).toBe("pass");
      expect(providerCheck?.detail).toContain("2 provider");
    });

    it("fails when providers have missing or empty commands", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({
          version: "1.0",
          execution: {
            adapter: "terminal-cli",
            providers: {
              codex: { command: "" },
              gemini: { command: "gemini" },
            },
          },
        }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const providerCheck = report.checks.find((c) => c.id === "provider-config");
      expect(providerCheck?.status).toBe("fail");
      expect(providerCheck?.message).toContain("misconfigured");
      expect(providerCheck?.detail).toContain("codex");
    });
  });

  describe("tracker checks", () => {
    it("passes when no tracker is configured", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({ version: "1.0" }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const trackerCheck = report.checks.find((c) => c.id === "tracker-config");
      expect(trackerCheck?.status).toBe("pass");
      expect(trackerCheck?.message).toContain("local mode");
    });

    it("passes when Linear tracker is fully configured", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({
          version: "1.0",
          tracker: {
            adapter: "linear",
            linear: {
              enabled: true,
              teamId: "team-123",
              projectId: "project-456",
            },
          },
        }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const trackerCheck = report.checks.find((c) => c.id === "tracker-config");
      expect(trackerCheck?.status).toBe("pass");
      expect(trackerCheck?.message).toContain("Linear tracker is configured");
    });

    it("warns when Linear tracker is enabled but missing teamId or projectId", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({
          version: "1.0",
          tracker: {
            adapter: "linear",
            linear: {
              enabled: true,
              teamId: "team-123",
            },
          },
        }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const trackerCheck = report.checks.find((c) => c.id === "tracker-config");
      expect(trackerCheck?.status).toBe("warn");
      expect(trackerCheck?.message).toContain("missing teamId or projectId");
    });

    it("warns when Linear tracker adapter is selected but not enabled", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({
          version: "1.0",
          tracker: {
            adapter: "linear",
            linear: {
              enabled: false,
            },
          },
        }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const trackerCheck = report.checks.find((c) => c.id === "tracker-config");
      expect(trackerCheck?.status).toBe("warn");
      expect(trackerCheck?.message).toContain("not enabled");
    });

    it("passes when MCP bridge tracker is enabled", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({
          version: "1.0",
          tracker: {
            adapter: "mcp-bridge",
            mcpBridge: {
              enabled: true,
            },
          },
        }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      const trackerCheck = report.checks.find((c) => c.id === "tracker-config");
      expect(trackerCheck?.status).toBe("pass");
      expect(trackerCheck?.message).toContain("MCP bridge tracker is configured");
    });
  });

  describe("artifact hygiene checks", () => {
    it("passes when no artifact directories exist", () => {
      const report = runDoctor(repoRoot!);
      
      const artifactCheck = report.checks.find((c) => c.id === "artifact-hygiene");
      expect(artifactCheck?.status).toBe("pass");
      expect(artifactCheck?.message).toContain("No Polaris artifact directories found");
    });

    it("warns when .polaris/runs directory exists", () => {
      const runsDir = join(repoRoot!, ".polaris", "runs");
      mkdirSync(runsDir, { recursive: true });

      const report = runDoctor(repoRoot!);
      
      const artifactCheck = report.checks.find((c) => c.id === "artifact-hygiene");
      expect(artifactCheck?.status).toBe("warn");
      expect(artifactCheck?.message).toContain("Runtime artifacts present");
      expect(artifactCheck?.detail).toContain(".polaris/runs");
    });

    it("warns when .taskchain_artifacts/polaris-run/runs directory exists", () => {
      const runsDir = join(repoRoot!, ".taskchain_artifacts", "polaris-run", "runs");
      mkdirSync(runsDir, { recursive: true });

      const report = runDoctor(repoRoot!);
      
      const artifactCheck = report.checks.find((c) => c.id === "artifact-hygiene");
      expect(artifactCheck?.status).toBe("warn");
      expect(artifactCheck?.message).toContain("Runtime artifacts present");
      expect(artifactCheck?.detail).toContain(".taskchain_artifacts/polaris-run/runs");
    });

    it("passes when .polaris directory exists but no runs directory", () => {
      mkdirSync(join(repoRoot!, ".polaris"), { recursive: true });

      const report = runDoctor(repoRoot!);
      
      const artifactCheck = report.checks.find((c) => c.id === "artifact-hygiene");
      expect(artifactCheck?.status).toBe("pass");
      expect(artifactCheck?.message).toContain("clean");
    });
  });

  describe("summary", () => {
    it("correctly counts pass, warn, and fail checks", () => {
      writeFileSync(
        join(repoRoot!, "polaris.config.json"),
        JSON.stringify({
          version: "1.0",
          execution: {
            adapter: "terminal-cli",
            providers: {
              codex: { command: "codex" },
            },
          },
        }),
        "utf-8",
      );

      const report = runDoctor(repoRoot!);
      
      expect(report.summary.pass).toBeGreaterThan(0);
      expect(typeof report.summary.warn).toBe("number");
      expect(typeof report.summary.fail).toBe("number");
      expect(report.summary.pass + report.summary.warn + report.summary.fail).toBe(report.checks.length);
    });
  });
});