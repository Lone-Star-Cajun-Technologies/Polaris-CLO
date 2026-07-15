import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseChartId,
  formatChartId,
  getTodayDate,
  getMaxSequenceForDate,
  generateNextChartId,
} from "./chart-id.js";

describe("chart-id", () => {
  describe("parseChartId", () => {
    it("parses a valid chart ID", () => {
      const result = parseChartId("CHART-2026-06-05-001");
      expect(result).toEqual({
        full: "CHART-2026-06-05-001",
        date: "2026-06-05",
        sequence: 1,
      });
    });

    it("parses a chart ID with sequence 999", () => {
      const result = parseChartId("CHART-2026-06-05-999");
      expect(result).toEqual({
        full: "CHART-2026-06-05-999",
        date: "2026-06-05",
        sequence: 999,
      });
    });

    it("returns null for invalid format", () => {
      expect(parseChartId("CHART-2026-06-05")).toBeNull();
      expect(parseChartId("CHART-2026-06-05-1")).toBeNull();
      expect(parseChartId("CHART-2026-06-05-0001")).toBeNull();
      expect(parseChartId("chart-2026-06-05-001")).toBeNull();
      expect(parseChartId("INVALID")).toBeNull();
    });
  });

  describe("formatChartId", () => {
    it("formats components into a chart ID", () => {
      expect(formatChartId("2026-06-05", 1)).toBe("CHART-2026-06-05-001");
      expect(formatChartId("2026-06-05", 42)).toBe("CHART-2026-06-05-042");
      expect(formatChartId("2026-06-05", 999)).toBe("CHART-2026-06-05-999");
    });
  });

  describe("getTodayDate", () => {
    it("returns today's date in YYYY-MM-DD format", () => {
      const date = getTodayDate();
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("getMaxSequenceForDate", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), "test-charts-"));
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it("returns 0 when directory does not exist", () => {
      const result = getMaxSequenceForDate("/tmp/nonexistent", "2026-06-05");
      expect(result).toBe(0);
    });

    it("returns 0 when no charts exist for the date", () => {
      writeFileSync(join(testDir, "CHART-2026-06-04-001.md"), "");
      writeFileSync(join(testDir, "other-file.md"), "");
      const result = getMaxSequenceForDate(testDir, "2026-06-05");
      expect(result).toBe(0);
    });

    it("returns the maximum sequence number for the date", () => {
      writeFileSync(join(testDir, "CHART-2026-06-05-001.md"), "");
      writeFileSync(join(testDir, "CHART-2026-06-05-003.md"), "");
      writeFileSync(join(testDir, "CHART-2026-06-05-002.md"), "");
      writeFileSync(join(testDir, "CHART-2026-06-04-999.md"), "");
      const result = getMaxSequenceForDate(testDir, "2026-06-05");
      expect(result).toBe(3);
    });

    it("handles single digit sequences", () => {
      writeFileSync(join(testDir, "CHART-2026-06-05-001.md"), "");
      const result = getMaxSequenceForDate(testDir, "2026-06-05");
      expect(result).toBe(1);
    });
  });

  describe("generateNextChartId", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), "test-charts-"));
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it("generates the first chart ID for a new day", () => {
      const result = generateNextChartId(testDir);
      expect(result.full).toMatch(/^CHART-\d{4}-\d{2}-\d{2}-001$/);
      expect(result.sequence).toBe(1);
    });

    it("increments the sequence when charts exist for today", () => {
      const today = getTodayDate();
      writeFileSync(join(testDir, `CHART-${today}-001.md`), "");
      writeFileSync(join(testDir, `CHART-${today}-002.md`), "");

      const result = generateNextChartId(testDir);
      expect(result.full).toMatch(/^CHART-\d{4}-\d{2}-\d{2}-003$/);
      expect(result.sequence).toBe(3);
    });

    it("resets sequence for a new day", () => {
      const yesterday = "2026-06-04";
      writeFileSync(join(testDir, "CHART-2026-06-04-005.md"), "");

      const result = generateNextChartId(testDir);
      expect(result.sequence).toBe(1);
    });

    it("does not return duplicate IDs under concurrent callers", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => generateNextChartId(testDir)),
      );
      const sequences = results.map((result) => result.sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(Math.max(...sequences)).toBe(10);
    });
  });
});