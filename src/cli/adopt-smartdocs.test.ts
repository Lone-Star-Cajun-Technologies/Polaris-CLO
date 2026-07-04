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

describe("scaffoldBundleRoot dry-run", () => {
  it("writes nothing when dryRun=true", () => {
    const root = makeRoot();
    scaffoldBundleRoot(root, true);
    expect(existsSync(join(root, "smartdocs", "index.md"))).toBe(false);
    expect(existsSync(join(root, "smartdocs", "log.md"))).toBe(false);
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

  it("dry-run: writes nothing when plan.dry_run=true", async () => {
    const root = makeRoot();
    const source = join(root, "docs", "old.md");
    writeFileSync(source, "# Old doc\n", "utf-8");

    const plan: import("./adoption-plan.js").AdoptionPlan = {
      ...makeEmptyPlan(),
      dry_run: true,
      steps: [
        {
          step_id: "d1",
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

    // source must still be present
    expect(existsSync(source)).toBe(true);
    // smartdocs bundle root must NOT be created
    expect(existsSync(join(root, "smartdocs", "index.md"))).toBe(false);
    expect(existsSync(join(root, "smartdocs", "log.md"))).toBe(false);
    // adoption-plan.json must NOT be written
    expect(existsSync(join(root, ".polaris", "adoption-plan.json"))).toBe(false);
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
});
