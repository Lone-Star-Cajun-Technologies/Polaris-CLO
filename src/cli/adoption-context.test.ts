import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyOperatorContext,
  loadOperatorContext,
  saveOperatorContext,
  type OperatorContext,
} from "./adoption-context.js";

const createdFixtures: string[] = [];

function makeFixtureRoot(name: string): string {
  const root = join(process.cwd(), ".taskchain_artifacts", "test-work", `${name}-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  createdFixtures.push(root);
  return root;
}

afterEach(() => {
  for (const path of createdFixtures.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("createEmptyOperatorContext", () => {
  it("returns a context with all required fields", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const ctx = createEmptyOperatorContext(now);
    expect(ctx.schema_version).toBe("1.0");
    expect(ctx.answered_at).toBe("2026-01-01T00:00:00.000Z");
    expect(ctx.trusted_docs).toEqual([]);
    expect(ctx.stale_docs).toEqual([]);
    expect(ctx.never_touch).toEqual([]);
    expect(ctx.priority_systems).toEqual([]);
    expect(ctx.instruction_file_intent).toEqual({});
  });

  it("uses current time when no date is supplied", () => {
    const before = new Date();
    const ctx = createEmptyOperatorContext();
    const after = new Date();
    const answeredAt = new Date(ctx.answered_at);
    expect(answeredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(answeredAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe("saveOperatorContext / loadOperatorContext", () => {
  it("round-trips a populated context", () => {
    const root = makeFixtureRoot("operator-context-roundtrip");
    const ctx: OperatorContext = {
      schema_version: "1.0",
      answered_at: "2026-01-01T00:00:00.000Z",
      trusted_docs: ["docs/architecture/"],
      stale_docs: ["docs/old/"],
      never_touch: ["legacy/", "vendor/"],
      priority_systems: ["billing", "auth"],
      instruction_file_intent: { "CLAUDE.md": "preserve", "AGENTS.md": "migrate" },
    };

    saveOperatorContext(root, ctx);

    const loaded = loadOperatorContext(root);
    expect(loaded).toEqual(ctx);
  });

  it("writes to .polaris/adoption/operator-context.json, not adoption-inventory.json", () => {
    const root = makeFixtureRoot("operator-context-path");
    const ctx = createEmptyOperatorContext(new Date("2026-01-01T00:00:00.000Z"));

    saveOperatorContext(root, ctx);

    const expectedPath = join(root, ".polaris", "adoption", "operator-context.json");
    const inventoryPath = join(root, ".polaris", "adoption-inventory.json");

    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(inventoryPath)).toBe(false);

    const raw = JSON.parse(readFileSync(expectedPath, "utf-8")) as OperatorContext;
    expect(raw.schema_version).toBe("1.0");
  });

  it("creates the .polaris/adoption directory if missing", () => {
    const root = makeFixtureRoot("operator-context-mkdir");
    const ctx = createEmptyOperatorContext();

    expect(existsSync(join(root, ".polaris", "adoption"))).toBe(false);
    saveOperatorContext(root, ctx);
    expect(existsSync(join(root, ".polaris", "adoption"))).toBe(true);
  });

  it("returns null when no context file exists", () => {
    const root = makeFixtureRoot("operator-context-missing");
    expect(loadOperatorContext(root)).toBeNull();
  });

  it("returns null when context file is malformed JSON", () => {
    const root = makeFixtureRoot("operator-context-malformed");
    mkdirSync(join(root, ".polaris", "adoption"), { recursive: true });
    writeFileSync(join(root, ".polaris", "adoption", "operator-context.json"), "not-json", "utf-8");
    expect(loadOperatorContext(root)).toBeNull();
  });
});
