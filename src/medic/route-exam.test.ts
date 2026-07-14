import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRouteExam } from "./route-exam.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "polaris-route-exam-"));
  mkdirSync(join(tmpRoot, ".polaris", "map"), { recursive: true });
  mkdirSync(join(tmpRoot, "src", "medic"), { recursive: true });

  writeFileSync(
    join(tmpRoot, ".polaris", "map", "file-routes.json"),
    JSON.stringify(
      {
        "src/medic/POLARIS.md": {
          domain: "medic",
          route: "src/medic",
          taskchain: "polaris-medic",
          confidence: 0.9,
          classification: "indexed",
          last_updated: new Date().toISOString(),
          updated_by: "test",
          tags: ["medic"],
          instructionFile: "src/medic/POLARIS.md",
          role_owner: "worker",
        },
        "src/medic/SUMMARY.md": {
          domain: "medic",
          route: "src/medic",
          taskchain: "polaris-medic",
          confidence: 0.9,
          classification: "indexed",
          last_updated: new Date().toISOString(),
          updated_by: "test",
          tags: ["medic"],
          instructionFile: "src/medic/POLARIS.md",
          role_owner: "worker",
        },
        "src/medic/foo.ts": {
          domain: "medic",
          route: "src/medic",
          taskchain: "polaris-medic",
          confidence: 0.9,
          classification: "indexed",
          last_updated: new Date().toISOString(),
          updated_by: "test",
          tags: ["medic"],
          instructionFile: "src/medic/POLARIS.md",
          role_owner: "worker",
        },
        "src/medic/foo.test.ts": {
          domain: "medic",
          route: "src/medic",
          taskchain: "polaris-medic",
          confidence: 0.9,
          classification: "indexed",
          last_updated: new Date().toISOString(),
          updated_by: "test",
          tags: ["medic", "test"],
          instructionFile: "src/medic/POLARIS.md",
          role_owner: "worker",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  writeFileSync(join(tmpRoot, "src", "medic", "POLARIS.md"), "# Medic\n", "utf-8");
  writeFileSync(join(tmpRoot, "src", "medic", "SUMMARY.md"), "## Summary\n", "utf-8");
  writeFileSync(join(tmpRoot, "src", "medic", "foo.ts"), "export const foo = 1;\n", "utf-8");
  writeFileSync(join(tmpRoot, "src", "medic", "foo.test.ts"), "import { foo } from './foo';\n", "utf-8");
});

function cleanup(): void {
  rmSync(tmpRoot, { recursive: true, force: true });
}

describe("runRouteExam", () => {
  it("builds a route-exam packet and writes a diagnostic chart", () => {
    const result = runRouteExam({ route: "src/medic", repoRoot: tmpRoot });

    expect(result.packet.route).toBe("src/medic");
    expect(result.packet.health_state).toBe("healthy");
    expect(result.packet.polaris_md).toBe("# Medic\n");
    expect(result.packet.summary_md).toBe("## Summary\n");
    expect(result.packet.owned_paths).toContain("src/medic/foo.ts");
    expect(result.packet.owned_paths).toContain("src/medic/foo.test.ts");
    expect(result.packet.relevant_tests).toEqual(["src/medic/foo.test.ts"]);
    expect(result.packet.chart_history).toEqual([]);
    expect(result.chart_id).toMatch(/^CHART-\d{4}-\d{2}-\d{2}-\d{3}$/);
    expect(result.chart_ref).toContain("smartdocs/medic/charts/");

    const chartContent = readFileSync(
      join(tmpRoot, result.chart_ref),
      "utf-8",
    );
    expect(chartContent).toContain("route: src/medic");
    expect(chartContent).toContain("health_state: healthy");
    expect(chartContent).toContain("## Problem");
    expect(chartContent).toContain("Proactive route exam for src/medic.");
    expect(chartContent).toContain("## Symptoms");
    expect(chartContent).toContain("Route src/medic health state is healthy.");

    cleanup();
  });

  it("normalizes a route with trailing slash and leading dot-slash", () => {
    const result = runRouteExam({ route: "./src/medic/", repoRoot: tmpRoot });
    expect(result.packet.route).toBe("src/medic");
    expect(result.chart_ref).toContain("smartdocs/medic/charts/");
    cleanup();
  });
});

