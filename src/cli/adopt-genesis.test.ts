import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

  it("thin pointer file left unchanged", async () => {
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

  it("refused — pointer prepended, original preserved", async () => {
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
    expect(fileContent).toMatch(/^<!-- See \[POLARIS\.md\]\(POLARIS\.md\) for repo instructions -->/);
    expect(fileContent).toContain(original);
    expect(results).toContainEqual({ file: "CLAUDE.md", outcome: "refused" });
  });

  it("accepted + key present — genesis written, file replaced", async () => {
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
    expect(claudeContent).toContain("POLARIS.md");
    expect(claudeContent).toContain(genesisPath);

    expect(results).toContainEqual({
      file: "CLAUDE.md",
      outcome: "compressed",
      genesisPath,
    });
  });
});
