import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaults.js";
import { getResolvedConfigJson } from "./show.js";

let repoRoot: string | undefined;

function makeRepo(): string {
  repoRoot = mkdtempSync(join(tmpdir(), "polaris-config-show-"));
  return repoRoot;
}

afterEach(() => {
  if (repoRoot) {
    rmSync(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  }
});

describe("config show", () => {
  it("prints resolved default config when no config file exists", () => {
    const root = makeRepo();

    const output = getResolvedConfigJson(root);

    expect(JSON.parse(output)).toEqual(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    expect(output).toBe(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  });

  it("prints merged user config as formatted JSON", () => {
    const root = makeRepo();
    writeFileSync(
      join(root, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        repo: { name: "example", sourceRoots: ["src", "packages"] },
        finalize: { targetBranch: "testing" },
      }),
      "utf-8",
    );

    const output = getResolvedConfigJson(root);

    expect(JSON.parse(output)).toMatchObject({
      version: "1.0",
      repo: { name: "example", sourceRoots: ["src", "packages"] },
      finalize: { targetBranch: "testing", prDraft: true },
    });
    expect(output).toContain('\n  "repo": {');
  });
});
