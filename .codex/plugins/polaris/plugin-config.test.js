import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

describe(".codex/plugins/polaris/.codex-plugin/plugin.json", () => {
  const pluginJsonPath = join(repoRoot, ".codex", "plugins", "polaris", ".codex-plugin", "plugin.json");
  const plugin = JSON.parse(readFileSync(pluginJsonPath, "utf8"));

  it("is valid JSON with the expected top-level identity fields", () => {
    expect(plugin.name).toBe("polaris");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.skills).toBe("./skills/");
  });

  it("describes the plugin as exposing governed skill wrappers, not just status helpers", () => {
    expect(plugin.description).toMatch(/governed/i);
    expect(plugin.description).toMatch(/skill wrapper/i);
  });

  it("declares Write capability in addition to Interactive and Read", () => {
    expect(plugin.interface.capabilities).toEqual(["Interactive", "Read", "Write"]);
  });

  it("documents that skill wrappers route through ROUTING.md and do not implement a parallel runtime", () => {
    expect(plugin.interface.longDescription).toContain(".polaris/skills/ROUTING.md");
    expect(plugin.interface.longDescription).toMatch(/do not implement a parallel runtime/i);
  });

  it("lists governed skill entry points as default prompts", () => {
    expect(plugin.interface.defaultPrompt).toEqual([
      "Use $polaris-run to execute a governed Polaris cluster",
      "Use $polaris-analyze to analyze a Polaris issue",
      "Use $polaris-tools to check compact Polaris run state",
    ]);
  });

  it("keeps the shared Polaris brand color", () => {
    expect(plugin.interface.brandColor).toBe("#6366F1");
  });
});

describe(".codex/.agents/plugins/marketplace.json", () => {
  const marketplacePath = join(repoRoot, ".codex", ".agents", "plugins", "marketplace.json");
  const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));

  it("declares the polaris-local marketplace", () => {
    expect(marketplace.name).toBe("polaris-local");
    expect(marketplace.interface.displayName).toBe("Polaris Local");
  });

  it("registers exactly one local plugin entry pointing at the polaris plugin directory", () => {
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins).toHaveLength(1);

    const [entry] = marketplace.plugins;
    expect(entry.name).toBe("polaris");
    expect(entry.source).toEqual({ source: "local", path: "./plugins/polaris" });
    expect(entry.category).toBe("Productivity");
  });

  it("gates installation availability and requires authentication on install", () => {
    const [entry] = marketplace.plugins;
    expect(entry.policy).toEqual({ installation: "AVAILABLE", authentication: "ON_INSTALL" });
  });
});

describe(".codex/config.toml", () => {
  const configPath = join(repoRoot, ".codex", "config.toml");
  const content = readFileSync(configPath, "utf8");

  it("registers the polaris-local marketplace as a local source", () => {
    expect(content).toContain("[marketplaces.polaris-local]");
    expect(content).toMatch(/source_type\s*=\s*"local"/);
    expect(content).toMatch(/source\s*=\s*"\.\/\.codex"/);
  });

  it("enables the polaris plugin sourced from polaris-local", () => {
    expect(content).toContain('[plugins."polaris@polaris-local"]');
    expect(content).toMatch(/enabled\s*=\s*true/);
  });
});