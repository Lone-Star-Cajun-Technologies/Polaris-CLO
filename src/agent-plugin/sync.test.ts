import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "./commands.js";
import { SHIM_VERSION } from "./claude-generator.js";
import { detectShimDrift, syncShims } from "./sync.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "polaris-sync-test-"));
}

describe("detectShimDrift", () => {
  it("reports all commands as missing when outDir is empty", () => {
    const dir = makeTmpDir();
    try {
      const report = detectShimDrift(dir);
      expect(report.missing).toHaveLength(SLASH_COMMANDS.length);
      expect(report.stale).toHaveLength(0);
      expect(report.orphaned).toHaveLength(0);
      expect(report.hasDrift).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("reports all commands as missing when outDir does not exist", () => {
    const parent = makeTmpDir();
    try {
      const dir = path.join(parent, "does-not-exist");
      const report = detectShimDrift(dir);
      expect(report.missing).toHaveLength(SLASH_COMMANDS.length);
      expect(report.hasDrift).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true });
    }
  });

  it("reports no drift after syncShims", () => {
    const dir = makeTmpDir();
    try {
      syncShims(dir);
      const report = detectShimDrift(dir);
      expect(report.missing).toHaveLength(0);
      expect(report.stale).toHaveLength(0);
      expect(report.orphaned).toHaveLength(0);
      expect(report.hasDrift).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("reports stale when a shim has an old version stamp", () => {
    const dir = makeTmpDir();
    try {
      syncShims(dir);
      // Overwrite one shim with a stale version
      const shimPath = path.join(dir, `${SLASH_COMMANDS[0].name}.md`);
      const content = fs.readFileSync(shimPath, "utf8");
      fs.writeFileSync(shimPath, content.replace(`polaris-shim-version: ${SHIM_VERSION}`, "polaris-shim-version: 0"), "utf8");
      const report = detectShimDrift(dir);
      expect(report.stale).toContain(SLASH_COMMANDS[0].name);
      expect(report.hasDrift).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("reports stale when a shim has no version stamp", () => {
    const dir = makeTmpDir();
    try {
      syncShims(dir);
      const shimPath = path.join(dir, `${SLASH_COMMANDS[0].name}.md`);
      fs.writeFileSync(shimPath, "# no stamp here", "utf8");
      const report = detectShimDrift(dir);
      expect(report.stale).toContain(SLASH_COMMANDS[0].name);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("reports orphaned shims not in manifest", () => {
    const dir = makeTmpDir();
    try {
      syncShims(dir);
      fs.writeFileSync(path.join(dir, "polaris-unknown.md"), "orphan", "utf8");
      const report = detectShimDrift(dir);
      expect(report.orphaned).toContain("polaris-unknown");
      expect(report.hasDrift).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe("syncShims", () => {
  it("writes one shim per manifest verb", () => {
    const dir = makeTmpDir();
    try {
      const { written } = syncShims(dir);
      expect(written).toHaveLength(SLASH_COMMANDS.length);
      for (const command of SLASH_COMMANDS) {
        expect(fs.existsSync(path.join(dir, `${command.name}.md`))).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("each written shim carries the current version stamp", () => {
    const dir = makeTmpDir();
    try {
      const { written } = syncShims(dir);
      for (const filePath of written) {
        const content = fs.readFileSync(filePath, "utf8");
        expect(content).toContain(`<!-- polaris-shim-version: ${SHIM_VERSION} -->`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("returns drift report captured before regeneration", () => {
    const dir = makeTmpDir();
    try {
      // First sync: all missing before
      const first = syncShims(dir);
      expect(first.drift.missing).toHaveLength(SLASH_COMMANDS.length);
      // Second sync: no drift before (shims just written)
      const second = syncShims(dir);
      expect(second.drift.hasDrift).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("removes orphaned shims not in the manifest", () => {
    const dir = makeTmpDir();
    try {
      syncShims(dir);
      const orphanPath = path.join(dir, "polaris-unknown.md");
      fs.writeFileSync(orphanPath, "orphan", "utf8");
      expect(fs.existsSync(orphanPath)).toBe(true);
      syncShims(dir);
      expect(fs.existsSync(orphanPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
