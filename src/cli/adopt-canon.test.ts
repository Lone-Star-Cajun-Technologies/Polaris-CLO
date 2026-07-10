import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichCanonFiles } from "./adopt-canon.js";

vi.mock("../config/loader.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    execution: {
      providers: {
        claude: { command: "claude", args: ["-p", "{{worker_prompt}}"] },
      },
      providerPolicy: {
        librarian: { providers: ["claude"] },
      },
    },
  }),
}));

vi.mock("../smartdocs-engine/librarian-dispatch.js", () => ({
  resolveLibrarianProvider: vi.fn().mockReturnValue("claude"),
}));

// Mock spawnSync to return a controlled agent response
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === "claude") {
      // Detect the route from the prompt args
      const prompt = args.find((a) => a.includes("Route folder:")) ?? "";
      const routeMatch = prompt.match(/Route folder: (\S+)/);
      const route = routeMatch?.[1] ?? "";
      if (route === "src") {
        return {
          stdout: JSON.stringify({
            relevant_docs: [{ path: "smartdocs/doctrine/active/AUTH.md", title: "Auth" }],
            summary_lines: ["Source area covering auth and core logic."],
            polaris_lines: ["This area owns the core auth pipeline.", "Follow the Auth doctrine for token handling."],
          }),
          status: 0,
        };
      }
      return {
        stdout: JSON.stringify({ relevant_docs: [], summary_lines: [], polaris_lines: [] }),
        status: 0,
      };
    }
    return { stdout: "", status: 1 };
  }),
}));

describe("enrichCanonFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adopt-canon-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function setupRepo(opts: { withDraft?: boolean; doctrineDocs?: boolean } = {}) {
    const { withDraft = true, doctrineDocs = true } = opts;
    mkdirSync(join(root, "src"), { recursive: true });
    if (doctrineDocs) {
      mkdirSync(join(root, "smartdocs", "doctrine", "active"), { recursive: true });
      writeFileSync(join(root, "smartdocs", "doctrine", "active", "AUTH.md"), "# Auth\n\nAuth doctrine.", "utf-8");
    }
    writeFileSync(join(root, "src", "POLARIS.md"), "# POLARIS\n", "utf-8");
    writeFileSync(
      join(root, "src", "SUMMARY.md"),
      withDraft
        ? "# Summary\n\n<!-- polaris:draft -->\n\nSome content.\n"
        : "# Summary\n\nSome content without draft marker.\n",
      "utf-8",
    );
  }

  it("injects linked_docs when librarian returns relevant docs", async () => {
    setupRepo();
    await enrichCanonFiles(root);
    const result = readFileSync(join(root, "src", "SUMMARY.md"), "utf-8");
    expect(result).toContain("linked_docs:");
    expect(result).toContain("AUTH.md");
  });

  it("injects summary_lines content from librarian response", async () => {
    setupRepo();
    await enrichCanonFiles(root);
    const result = readFileSync(join(root, "src", "SUMMARY.md"), "utf-8");
    expect(result).toContain("Source area covering auth and core logic.");
  });

  it("skips already-promoted SUMMARY.md (no draft marker)", async () => {
    setupRepo({ withDraft: false });
    await enrichCanonFiles(root);
    const result = readFileSync(join(root, "src", "SUMMARY.md"), "utf-8");
    expect(result).not.toContain("linked_docs:");
  });

  it("escapes double quotes in linked doc title", async () => {
    setupRepo();
    // Override spawnSync for this test to return a title with quotes
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: JSON.stringify({
        relevant_docs: [{ path: "smartdocs/doctrine/active/AUTH.md", title: 'The "Auth" Module' }],
        summary_lines: [],
      }),
      status: 0,
    } as ReturnType<typeof spawnSync>);

    await enrichCanonFiles(root);
    const result = readFileSync(join(root, "src", "SUMMARY.md"), "utf-8");
    expect(result).toContain('title: "The \\"Auth\\" Module"');
    expect(result).not.toMatch(/title: "The "Auth"/);
  });

  it("writes POLARIS.md with operational instructions", async () => {
    setupRepo();
    await enrichCanonFiles(root);
    const polaris = readFileSync(join(root, "src", "POLARIS.md"), "utf-8");
    expect(polaris).toContain("# POLARIS — src");
    expect(polaris).toContain("This area owns the core auth pipeline.");
  });

  it("throws when no agent is configured", async () => {
    const { resolveLibrarianProvider } = await import("../smartdocs-engine/librarian-dispatch.js");
    vi.mocked(resolveLibrarianProvider).mockReturnValueOnce(null).mockReturnValueOnce(null);
    setupRepo();
    await expect(enrichCanonFiles(root)).rejects.toThrow("polaris agent setup required");
  });

  it("prompts the librarian with separate include/avoid lists for each artifact", async () => {
    setupRepo();
    const { spawnSync } = await import("node:child_process");
    const calls: string[][] = [];
    vi.mocked(spawnSync).mockImplementation(((_cmd: unknown, args: unknown, _options?: unknown) => {
      if (args !== undefined && (!Array.isArray(args) || !args.every((value) => typeof value === "string"))) {
        throw new Error("Expected spawnSync args to be string[]");
      }
      const normalizedArgs = args ?? [];
      calls.push(normalizedArgs);
      return { stdout: JSON.stringify({ relevant_docs: [], summary_lines: [], polaris_lines: [] }), status: 0 } as ReturnType<typeof spawnSync>;
    }) as typeof spawnSync);

    await enrichCanonFiles(root);

    const promptArgs = calls.find((args) => args.some((a) => a.includes("Route folder:"))) ?? [];
    const prompt = promptArgs.find((a) => a.includes("Route folder:")) ?? "";
    expect(prompt).toContain("SUMMARY.md content (current-state memory / navigation index)");
    expect(prompt).toContain("POLARIS.md content (route operating guidance)");
    expect(prompt).toContain("Avoid: operational procedures");
    expect(prompt).toContain("Avoid: navigation-index content");
  });

  it("places summary_lines in SUMMARY.md and polaris_lines in POLARIS.md", async () => {
    setupRepo();
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockReturnValueOnce({
      stdout: JSON.stringify({
        relevant_docs: [{ path: "smartdocs/doctrine/active/AUTH.md", title: "Auth" }],
        summary_lines: ["This is a summary-only line."],
        polaris_lines: ["This is a polaris-only line."],
      }),
      status: 0,
    } as ReturnType<typeof spawnSync>);

    await enrichCanonFiles(root);

    const summary = readFileSync(join(root, "src", "SUMMARY.md"), "utf-8");
    const polaris = readFileSync(join(root, "src", "POLARIS.md"), "utf-8");
    expect(summary).toContain("This is a summary-only line.");
    expect(summary).not.toContain("This is a polaris-only line.");
    expect(polaris).toContain("This is a polaris-only line.");
    expect(polaris).not.toContain("This is a summary-only line.");
  });
});
