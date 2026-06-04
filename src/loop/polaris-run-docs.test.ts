import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const FOREMAN = join(ROOT, ".polaris", "roles", "foreman.md");
const CHAIN = join(ROOT, ".polaris", "skills", "polaris-run", "chain.md");

describe("Quiet Foreman mode docs", () => {
  it("prohibits raw worker-output review and live repair in foreman.md", () => {
    const content = readFileSync(FOREMAN, "utf-8");
    expect(content).toContain("Reading or summarizing raw worker output");
    expect(content).toContain("Performing live repair of worker code, packets, or runtime state");
  });

  it("adds a checkpoint gate that only preserves CompactReturn JSON in chain.md", () => {
    const content = readFileSync(CHAIN, "utf-8");
    expect(content).toContain("CHECKPOINT gate");
    expect(content).toContain("discard worker output except the CompactReturn JSON object");
    expect(content).toContain("Preserve the existing step order");
  });

  it("keeps the polaris-run step order intact", () => {
    const content = readFileSync(CHAIN, "utf-8");
    const steps = [
      "01-orient-cluster",
      "02-prepare-branch",
      "03-select-child",
      "04-execute-child",
      "05-validate-child",
      "06-commit-and-update-linear",
      "07-decide-continuation",
      "08-closeout-librarian",
      "09-final-delivery",
    ];

    let lastIndex = -1;
    for (const step of steps) {
      const index = content.indexOf(step);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });
});
