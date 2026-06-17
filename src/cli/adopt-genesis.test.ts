import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue("y"),
    close: vi.fn(),
  })),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "- Use TypeScript\n- Follow TDD\n" }],
      }),
    },
  })),
}));

import * as rlMod from "node:readline/promises";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "polaris-genesis-test-"));
}

describe("reconcileAgentFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset readline mock to default "y"
    vi.mocked(rlMod.createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue("y"),
      close: vi.fn(),
    } as unknown as ReturnType<typeof rlMod.createInterface>);
  });

  it("thin pointer file (POLARIS.md) left unchanged", async () => {
    const root = tempDir();
    const thinContent =
      "# Agent Instructions\n\nRead [POLARIS.md](POLARIS.md) before beginning any work.\n";
    writeFileSync(join(root, "CLAUDE.md"), thinContent, "utf8");

    const { reconcileAgentFiles } = await import("./adopt-genesis.js");
    const results = await reconcileAgentFiles(root);

    const fileContent = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(fileContent).toBe(thinContent);
    expect(results).toContainEqual({ file: "CLAUDE.md", outcome: "already-present" });
  });

  it("thin pointer file (POLARIS_RULES.md) left unchanged", async () => {
    const root = tempDir();
    const thinContent =
      "# Agent Instructions\n\nRead [POLARIS_RULES.md](POLARIS_RULES.md) before beginning any work.\n";
    writeFileSync(join(root, "CLAUDE.md"), thinContent, "utf8");

    const { reconcileAgentFiles } = await import("./adopt-genesis.js");
    const results = await reconcileAgentFiles(root);

    const fileContent = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(fileContent).toBe(thinContent);
    expect(results).toContainEqual({ file: "CLAUDE.md", outcome: "already-present" });
  });

  it("refused — POLARIS_RULES.md pointer prepended, original preserved", async () => {
    const root = tempDir();
    const original =
      "# My Custom Instructions\n\nDo A.\nDo B.\nDo C.\nDo D.\nDo E.\nDo F.\n";
    writeFileSync(join(root, "CLAUDE.md"), original, "utf8");

    vi.mocked(rlMod.createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue("n"),
      close: vi.fn(),
    } as unknown as ReturnType<typeof rlMod.createInterface>);

    const { reconcileAgentFiles } = await import("./adopt-genesis.js");
    const results = await reconcileAgentFiles(root);

    const fileContent = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(fileContent).toMatch(
      /^<!-- See \[POLARIS_RULES\.md\]\(POLARIS_RULES\.md\) for repo instructions -->/,
    );
    expect(fileContent).toContain(original);
    expect(results).toContainEqual({ file: "CLAUDE.md", outcome: "refused" });
  });

  it("accepted + key present — genesis written, file replaced with POLARIS_RULES.md pointer", async () => {
    const root = tempDir();
    const original =
      "# My Custom Instructions\n\nDo A.\nDo B.\nDo C.\nDo D.\nDo E.\nDo F.\n";
    writeFileSync(join(root, "CLAUDE.md"), original, "utf8");
    mkdirSync(join(root, "smartdocs/doctrine/active"), { recursive: true });

    const { reconcileAgentFiles } = await import("./adopt-genesis.js");
    const results = await reconcileAgentFiles(root, {
      anthropicKey: "test-key",
      now: new Date("2026-06-09"),
    });

    const genesisPath = "smartdocs/doctrine/active/2026-06-09-genesis-agent-doctrine.md";
    const genesisContent = readFileSync(join(root, genesisPath), "utf8");
    expect(genesisContent).toContain("- Use TypeScript");

    const claudeContent = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claudeContent).toContain("POLARIS_RULES.md");
    expect(claudeContent).toContain(genesisPath);

    expect(results).toContainEqual({
      file: "CLAUDE.md",
      outcome: "compressed",
      genesisPath,
    });
  });

  it("provenance is written to .polaris/adoption-provenance.json", async () => {
    const root = tempDir();
    const thinContent =
      "# Agent Instructions\n\nRead [POLARIS_RULES.md](POLARIS_RULES.md) before beginning any work.\n";
    writeFileSync(join(root, "CLAUDE.md"), thinContent, "utf8");

    const { reconcileAgentFiles } = await import("./adopt-genesis.js");
    await reconcileAgentFiles(root, { now: new Date("2026-06-09T00:00:00Z") });

    const provenancePath = join(root, ".polaris", "adoption-provenance.json");
    expect(existsSync(provenancePath)).toBe(true);

    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
      genesis_reconcile_actions: Array<{
        source_path: string;
        decision: string;
        migration_outcome: string;
        timestamp: string;
        backup_path: string | null;
      }>;
    };
    expect(provenance.genesis_reconcile_actions).toHaveLength(1);
    expect(provenance.genesis_reconcile_actions[0].source_path).toBe("CLAUDE.md");
    expect(provenance.genesis_reconcile_actions[0].decision).toBe("already-pointer");
    expect(provenance.genesis_reconcile_actions[0].migration_outcome).toBe("already-present");
    expect(provenance.genesis_reconcile_actions[0].backup_path).toBeNull();
    expect(provenance.genesis_reconcile_actions[0].timestamp).toBe("2026-06-09T00:00:00.000Z");
  });

  it("provenance records refused outcome with migration_outcome field", async () => {
    const root = tempDir();
    const original = "# My Custom Instructions\n\nDo A.\nDo B.\nDo C.\nDo D.\nDo E.\nDo F.\n";
    writeFileSync(join(root, "CLAUDE.md"), original, "utf8");

    vi.mocked(rlMod.createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue("n"),
      close: vi.fn(),
    } as unknown as ReturnType<typeof rlMod.createInterface>);

    const { reconcileAgentFiles } = await import("./adopt-genesis.js");
    await reconcileAgentFiles(root, { now: new Date("2026-06-09T00:00:00Z") });

    const provenancePath = join(root, ".polaris", "adoption-provenance.json");
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
      genesis_reconcile_actions: Array<{ migration_outcome: string; decision: string }>;
    };
    expect(provenance.genesis_reconcile_actions[0].migration_outcome).toBe("refused");
    expect(provenance.genesis_reconcile_actions[0].decision).toBe("refused-compression");
  });
});
