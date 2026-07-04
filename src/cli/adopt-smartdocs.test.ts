import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSmartDocs, scaffoldBundleRoot } from "./adopt-smartdocs.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "polaris-adopt-smartdocs-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  return root;
}

function makeEmptyPlan(): import("./adoption-plan.js").AdoptionPlan {
  return {
    plan_id: "test-empty",
    generated_at: "2026-07-03T00:00:00.000Z",
    repo_state: "existing",
    approved: true,
    approved_at: "2026-07-03T00:00:00.000Z",
    dry_run: false,
    steps: [],
    impact_summary: {
      files_to_create: 0,
      files_to_move: 0,
      files_to_modify: 0,
      instruction_files_affected: 0,
      smartdocs_candidates_moved: 0,
      cognition_files_to_generate: 0,
    },
  };
}

describe("scaffoldBundleRoot", () => {
  it("creates both files when both are missing", () => {
    const root = makeRoot();
    scaffoldBundleRoot(root);
    expect(existsSync(join(root, "smartdocs", "index.md"))).toBe(true);
    expect(existsSync(join(root, "smartdocs", "log.md"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("writes an index.md matching the architecture-doc §7.2 template", () => {
    const root = makeRoot();
    scaffoldBundleRoot(root);
    const content = readFileSync(join(root, "smartdocs", "index.md"), "utf-8");
    expect(content).toContain('okf_version: "0.1"');
    expect(content).toContain("# SmartDocs — Polaris Cognition Bundle");
    expect(content).toContain("# Governance");
    expect(content).toContain("specs/active/docs-authority-model.md");
    expect(content).toContain("doctrine/active/");
    expect(content).toContain("# Routes");
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a log.md with only the reserved change-log header and no seeded entries", () => {
    const root = makeRoot();
    scaffoldBundleRoot(root);
    const content = readFileSync(join(root, "smartdocs", "log.md"), "utf-8");
    expect(content).toBe("# SmartDocs — Change Log\n");
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the smartdocs directory when it does not yet exist", () => {
    const root = makeRoot();
    expect(existsSync(join(root, "smartdocs"))).toBe(false);
    scaffoldBundleRoot(root);
    expect(existsSync(join(root, "smartdocs"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("is idempotent across repeated calls and never mutates existing content", () => {
    const root = makeRoot();
    scaffoldBundleRoot(root);
    const firstIndex = readFileSync(join(root, "smartdocs", "index.md"), "utf-8");
    const firstLog = readFileSync(join(root, "smartdocs", "log.md"), "utf-8");

    scaffoldBundleRoot(root);
    scaffoldBundleRoot(root);

    expect(readFileSync(join(root, "smartdocs", "index.md"), "utf-8")).toBe(firstIndex);
    expect(readFileSync(join(root, "smartdocs", "log.md"), "utf-8")).toBe(firstLog);
    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op when both files already exist", () => {
    const root = makeRoot();
    mkdirSync(join(root, "smartdocs"), { recursive: true });
    writeFileSync(join(root, "smartdocs", "index.md"), "custom index", "utf-8");
    writeFileSync(join(root, "smartdocs", "log.md"), "custom log", "utf-8");
    scaffoldBundleRoot(root);
    expect(readFileSync(join(root, "smartdocs", "index.md"), "utf-8")).toBe("custom index");
    expect(readFileSync(join(root, "smartdocs", "log.md"), "utf-8")).toBe("custom log");
    rmSync(root, { recursive: true, force: true });
  });

  it("creates only the missing file when exactly one exists", () => {
    const root = makeRoot();
    mkdirSync(join(root, "smartdocs"), { recursive: true });
    writeFileSync(join(root, "smartdocs", "index.md"), "custom index", "utf-8");
    scaffoldBundleRoot(root);
    expect(readFileSync(join(root, "smartdocs", "index.md"), "utf-8")).toBe("custom index");
    expect(readFileSync(join(root, "smartdocs", "log.md"), "utf-8")).toBe("# SmartDocs — Change Log\n");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("migrateSmartDocs", () => {
  it("calls scaffoldBundleRoot unconditionally when there are zero migration steps", async () => {
    const root = makeRoot();
    await migrateSmartDocs(makeEmptyPlan(), root);
    expect(existsSync(join(root, "smartdocs", "index.md"))).toBe(true);
    expect(existsSync(join(root, "smartdocs", "log.md"))).toBe(true);
    expect(existsSync(join(root, ".polaris", "adoption-plan.json"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("moves a candidate file and still creates smartdocs bundle root", async () => {
    const root = makeRoot();
    const source = join(root, "docs", "old.md");
    const dest = join(root, "smartdocs", "raw", "old.md");
    writeFileSync(source, "# Old doc\n", "utf-8");

    const plan: import("./adoption-plan.js").AdoptionPlan = {
      ...makeEmptyPlan(),
      steps: [
        {
          step_id: "m1",
          order: 1,
          phase: "C",
          category: "smartdocs-migrate",
          action: "move",
          source_path: "docs/old.md",
          dest_path: "smartdocs/raw/old.md",
          description: "Move old.md",
          destructive: true,
          requires_approval: true,
          estimated_risk: "low",
          status: "pending",
          routing: "candidate",
        },
      ],
    };

    await migrateSmartDocs(plan, root);

    expect(existsSync(source)).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe("# Old doc\n");
    expect(existsSync(join(root, "smartdocs", "index.md"))).toBe(true);
    expect(existsSync(join(root, "smartdocs", "log.md"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("scaffolds the bundle root even when only non-smartdocs-migrate steps are present", async () => {
    const root = makeRoot();
    const plan: import("./adoption-plan.js").AdoptionPlan = {
      ...makeEmptyPlan(),
      steps: [
        {
          step_id: "p1",
          order: 1,
          phase: "A",
          category: "provider-config",
          action: "modify",
          dest_path: "polaris.config.json",
          description: "Write minimal provider config lock.",
          destructive: false,
          requires_approval: false,
          estimated_risk: "low",
          status: "pending",
        },
      ],
    };

    await migrateSmartDocs(plan, root);

    expect(existsSync(join(root, "smartdocs", "index.md"))).toBe(true);
    expect(existsSync(join(root, "smartdocs", "log.md"))).toBe(true);
    expect(plan.steps[0].status).toBe("pending");
    rmSync(root, { recursive: true, force: true });
  });

  it("does not overwrite bundle-root files across repeated migrateSmartDocs runs", async () => {
    const root = makeRoot();
    await migrateSmartDocs(makeEmptyPlan(), root);
    writeFileSync(join(root, "smartdocs", "index.md"), "operator-edited index", "utf-8");
    writeFileSync(join(root, "smartdocs", "log.md"), "operator-edited log", "utf-8");

    await migrateSmartDocs(makeEmptyPlan(), root);

    expect(readFileSync(join(root, "smartdocs", "index.md"), "utf-8")).toBe("operator-edited index");
    expect(readFileSync(join(root, "smartdocs", "log.md"), "utf-8")).toBe("operator-edited log");
    rmSync(root, { recursive: true, force: true });
  });
});
