import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanAdoptionInventory } from "./adoption-inventory.js";

const createdFixtures: string[] = [];

function makeFixtureRoot(name: string): string {
  const root = join(process.cwd(), ".taskchain_artifacts", "test-work", `${name}-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  createdFixtures.push(root);
  return root;
}

function writeFixture(root: string, path: string, content: string): void {
  const fullPath = join(root, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

afterEach(() => {
  for (const path of createdFixtures.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("scanAdoptionInventory", () => {
  it("builds RepoScanInventory and writes adoption-inventory.json", () => {
    const fixtureRoot = makeFixtureRoot("adoption-inventory");

    writeFixture(
      fixtureRoot,
      "package.json",
      JSON.stringify(
        {
          name: "fixture",
          scripts: {
            test: "vitest",
            "test:integration": "vitest --run src/integration",
            build: "tsc -p .",
            typecheck: "tsc --noEmit",
          },
        },
        null,
        2,
      ),
    );
    writeFixture(fixtureRoot, "src/index.ts", "export const ok = true;\n");
    writeFixture(
      fixtureRoot,
      "docs/architecture.md",
      "---\ntitle: Architecture\n---\n\n# Architecture\n\nThis document contains architecture guidance and migration notes for testing purposes.\n",
    );
    writeFixture(fixtureRoot, "POLARIS.md", "# Doctrine\n");
    writeFixture(
      fixtureRoot,
      "CLAUDE.md",
      "# Claude\n\n<!-- polaris:delegate -->\nFollow POLARIS.md for routing.\n",
    );
    writeFixture(
      fixtureRoot,
      "AGENTS.md",
      "# AGENTS\n\n" + "Long instructions. ".repeat(40),
    );
    writeFixture(fixtureRoot, ".cursor/rules/style.md", "cursor rules\n");
    writeFixture(fixtureRoot, "smartdocs/raw/existing.md", "already migrated\n");
    writeFixture(fixtureRoot, "dist/bundle.js", "compiled\n");
    writeFixture(fixtureRoot, ".turbo/cache/index.json", "{}\n");
    writeFixture(fixtureRoot, "tests/fixtures/sample.json", "{}\n");

    const now = new Date("2026-01-01T00:00:00.000Z");
    const inventory = scanAdoptionInventory(fixtureRoot, { now });

    expect(inventory.scan_date).toBe(now.toISOString());
    expect(inventory.repo_state).toBe("existing");
    expect(inventory.package_manager).toBe("npm");
    expect(inventory.source_roots).toContain("src/");
    expect(inventory.docs_roots).toContain("docs/");
    expect(inventory.test_commands).toEqual([
      "npm run test:integration",
      "npm test",
    ]);
    expect(inventory.build_commands).toEqual([
      "npm run build",
      "npm run typecheck",
    ]);
    expect(inventory.generated_roots).toContain("dist/");
    expect(inventory.cache_roots).toContain(".turbo/");
    expect(inventory.fixture_roots).toContain("tests/fixtures/");
    expect(inventory.existing_smartdocs_dirs).toContain("smartdocs/");
    expect(inventory.architecture_notes).toContain("docs/architecture.md");
    expect(inventory.likely_canonical_folders).toContain("src");
    expect(inventory.likely_canonical_folders).toContain("docs");
    expect(inventory.ignore_candidates).toContain("dist/");

    const claude = inventory.agent_instruction_files.find((file) => file.path === "CLAUDE.md");
    expect(claude?.provider).toBe("claude");
    expect(claude?.recommendation).toBe("preserve");
    expect(claude?.has_polaris_delegation).toBe(true);

    const agents = inventory.agent_instruction_files.find((file) => file.path === "AGENTS.md");
    expect(agents?.provider).toBe("openai");
    expect(agents?.recommendation).toBe("migrate");

    const cursorRules = inventory.agent_instruction_files.find(
      (file) => file.path === ".cursor/rules/style.md",
    );
    expect(cursorRules?.provider).toBe("cursor");
    expect(cursorRules?.recommendation).toBe("thin-adapter");

    expect(inventory.smartdocs_candidates).toEqual([
      {
        path: "docs/architecture.md",
        kind: "architecture",
        suggested_destination: "smartdocs/raw/architecture.md",
        confidence: 0.95,
        has_frontmatter: true,
        estimated_risk: "medium",
      },
    ]);

    const inventoryPath = join(fixtureRoot, ".polaris", "adoption-inventory.json");
    expect(existsSync(inventoryPath)).toBe(true);
    const written = JSON.parse(readFileSync(inventoryPath, "utf-8")) as { repo_state: string };
    expect(written.repo_state).toBe("existing");
  });

  it("reports polaris-enabled when .polaris already exists", () => {
    const fixtureRoot = makeFixtureRoot("adoption-inventory-state");
    mkdirSync(join(fixtureRoot, ".polaris"), { recursive: true });

    const inventory = scanAdoptionInventory(fixtureRoot, { writeArtifact: false });
    expect(inventory.repo_state).toBe("polaris-enabled");
  });
});
