import { describe, it, expect } from "vitest";
import { inferRoute } from "./inference.js";
import type { PolarisConfig } from "../config/schema.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";

const config = DEFAULT_CONFIG as Required<PolarisConfig>;

describe("inferRoute", () => {
  it("classifies a file under a sourceRoot subdirectory", () => {
    const result = inferRoute("src/cli/index.ts", "/repo", config, {}, "");
    expect(result.domain).toBe("cli");
    expect(result.route).toBe("src/cli");
    expect(result.taskchain).toBe("polaris-cli");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.tags).toContain("cli");
    expect(result.tags).toContain("entry-point");
  });

  it("classifies a map domain file", () => {
    const result = inferRoute("src/map/atlas.ts", "/repo", config, {}, "");
    expect(result.domain).toBe("map");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("returns low confidence for files outside sourceRoots", () => {
    const result = inferRoute("package.json", "/repo", config, {}, "");
    expect(result.confidence).toBeLessThan(0.85);
  });

  it("tags test files", () => {
    const result = inferRoute("src/cli/version.test.ts", "/repo", config, {}, "");
    expect(result.tags).toContain("test");
  });

  it("boosts confidence from branch name", () => {
    const base = inferRoute("src/map/index.ts", "/repo", config, {}, "");
    const withBranch = inferRoute("src/map/index.ts", "/repo", config, {}, "philmeaux/pol-4-cluster-3-polaris-map");
    expect(withBranch.confidence).toBeGreaterThanOrEqual(base.confidence);
  });
});
