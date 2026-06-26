import { describe, it, expect, vi } from "vitest";
import { resolveForeman } from "./agent-setup.js";

const MOCK_PROVIDERS = [
  { name: "claude", displayName: "Claude (Anthropic)", installed: true },
  { name: "codex", displayName: "Codex (OpenAI)", installed: true },
  { name: "devin", displayName: "Devin (Cognition)", installed: false },
];

const ROLE_FILE = ".polaris/roles/foreman.md";
const REPO_ROOT = "/fake-repo";

// Helpers
function mockSelect(provider: string) {
  return vi.fn().mockResolvedValue(provider);
}

describe("resolveForeman — provider already configured", () => {
  it("returns the configured provider without prompting", async () => {
    const config = {
      execution: {
        providerPolicy: {
          foreman: { providers: ["codex"] },
        },
      },
    };

    const writeConfig = vi.fn();
    const selectProvider = vi.fn();

    const result = await resolveForeman(REPO_ROOT, config, { writeConfig, selectProvider });

    expect(result).toEqual({ provider: "codex", roleFile: ROLE_FILE });
    expect(writeConfig).not.toHaveBeenCalled();
    expect(selectProvider).not.toHaveBeenCalled();
  });

  it("uses the first provider in the list when multiple are configured", async () => {
    const config = {
      execution: {
        providerPolicy: {
          foreman: { providers: ["claude", "codex"] },
        },
      },
    };

    const result = await resolveForeman(REPO_ROOT, config, { writeConfig: vi.fn() });

    expect(result.provider).toBe("claude");
  });
});

describe("resolveForeman — provider not configured", () => {
  it("prompts once and returns the chosen provider", async () => {
    const config: Record<string, unknown> = {};
    const writeConfig = vi.fn();

    const result = await resolveForeman(REPO_ROOT, config, {
      writeConfig,
      detectProviders: () => MOCK_PROVIDERS,
      selectProvider: mockSelect("claude"),
    });

    expect(result).toEqual({ provider: "claude", roleFile: ROLE_FILE });
  });

  it("persists the chosen provider to config", async () => {
    const config: Record<string, unknown> = {};
    const writeConfig = vi.fn();

    await resolveForeman(REPO_ROOT, config, {
      writeConfig,
      detectProviders: () => MOCK_PROVIDERS,
      selectProvider: mockSelect("claude"),
    });

    expect(writeConfig).toHaveBeenCalledOnce();
    const [writtenPath, writtenConfig] = writeConfig.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(writtenPath).toBe(`${REPO_ROOT}/polaris.config.json`);
    const policy = (
      (writtenConfig.execution as Record<string, unknown>).providerPolicy as Record<
        string,
        unknown
      >
    ).foreman as Record<string, unknown>;
    expect(policy.providers).toEqual(["claude"]);
  });

  it("preserves existing foreman policy fields when persisting", async () => {
    const config: Record<string, unknown> = {
      execution: {
        providerPolicy: {
          foreman: { allowNativeSubagent: false }, // no providers yet
        },
      },
    };
    const writeConfig = vi.fn();

    await resolveForeman(REPO_ROOT, config, {
      writeConfig,
      detectProviders: () => MOCK_PROVIDERS,
      selectProvider: mockSelect("claude"),
    });

    const [, writtenConfig] = writeConfig.mock.calls[0] as [string, Record<string, unknown>];
    const foremanPolicy = (
      (writtenConfig.execution as Record<string, unknown>).providerPolicy as Record<
        string,
        unknown
      >
    ).foreman as Record<string, unknown>;

    expect(foremanPolicy.allowNativeSubagent).toBe(false);
    expect(foremanPolicy.providers).toEqual(["claude"]);
  });

  it("preserves other providerPolicy roles when persisting", async () => {
    const config: Record<string, unknown> = {
      execution: {
        providerPolicy: {
          worker: { providers: ["devin"] },
        },
      },
    };
    const writeConfig = vi.fn();

    await resolveForeman(REPO_ROOT, config, {
      writeConfig,
      detectProviders: () => MOCK_PROVIDERS,
      selectProvider: mockSelect("claude"),
    });

    const [, writtenConfig] = writeConfig.mock.calls[0] as [string, Record<string, unknown>];
    const policy = (writtenConfig.execution as Record<string, unknown>)
      .providerPolicy as Record<string, unknown>;
    expect((policy.worker as Record<string, unknown>).providers).toEqual(["devin"]);
  });

  it("throws when no provider is available (selectProvider returns null)", async () => {
    const config: Record<string, unknown> = {};

    await expect(
      resolveForeman(REPO_ROOT, config, {
        writeConfig: vi.fn(),
        detectProviders: () => MOCK_PROVIDERS.map((p) => ({ ...p, installed: false })),
        selectProvider: vi.fn().mockResolvedValue(null),
      }),
    ).rejects.toThrow("No supported agent installed");
  });

  it("binding roleFile always points to .polaris/roles/foreman.md", async () => {
    const result = await resolveForeman(REPO_ROOT, {}, {
      writeConfig: vi.fn(),
      detectProviders: () => MOCK_PROVIDERS,
      selectProvider: mockSelect("codex"),
    });

    expect(result.roleFile).toBe(".polaris/roles/foreman.md");
  });

  it("passes detected providers list to the selectProvider hook", async () => {
    const config: Record<string, unknown> = {};
    const selectProvider = mockSelect("claude");

    await resolveForeman(REPO_ROOT, config, {
      writeConfig: vi.fn(),
      detectProviders: () => MOCK_PROVIDERS,
      selectProvider,
    });

    expect(selectProvider).toHaveBeenCalledWith(MOCK_PROVIDERS);
  });
});
