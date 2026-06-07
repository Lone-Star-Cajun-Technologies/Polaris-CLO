import { describe, it, expect } from "vitest";
import {
  validateChartFrontMatter,
  validateChartSections,
  validateChart,
  REQUIRED_SECTIONS,
} from "./chart-schema.js";

describe("chart-schema", () => {
  describe("validateChartFrontMatter", () => {
    it("accepts valid front-matter with all required fields", () => {
      const frontMatter = {
        chart_id: "CHART-2026-06-05-001",
        cluster_id: "POL-327",
        route: "src/medic",
        status: "active",
        related_charts: [],
        created: "2026-06-05T12:00:00Z",
        updated: "2026-06-05T12:00:00Z",
      };

      const result = validateChartFrontMatter(frontMatter);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects missing required fields", () => {
      const frontMatter = {
        chart_id: "CHART-2026-06-05-001",
        cluster_id: "POL-327",
      };

      const result = validateChartFrontMatter(frontMatter);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("route"))).toBe(true);
    });

    it("rejects invalid chart_id format", () => {
      const frontMatter = {
        chart_id: "INVALID",
        cluster_id: "POL-327",
        route: "src/medic",
        status: "active",
        related_charts: [],
        created: "2026-06-05T12:00:00Z",
        updated: "2026-06-05T12:00:00Z",
      };

      const result = validateChartFrontMatter(frontMatter);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("chart_id") && e.includes("format")),
      ).toBe(true);
    });

    it("rejects chart_id without zero-padding", () => {
      const frontMatter = {
        chart_id: "CHART-2026-06-05-1",
        cluster_id: "POL-327",
        route: "src/medic",
        status: "active",
        related_charts: [],
        created: "2026-06-05T12:00:00Z",
        updated: "2026-06-05T12:00:00Z",
      };

      const result = validateChartFrontMatter(frontMatter);
      expect(result.valid).toBe(false);
    });

    it("accepts optional drift_observations field", () => {
      const frontMatter = {
        chart_id: "CHART-2026-06-05-001",
        cluster_id: "POL-327",
        route: "src/medic",
        status: "active",
        related_charts: [],
        created: "2026-06-05T12:00:00Z",
        updated: "2026-06-05T12:00:00Z",
        drift_observations: ["summary_outdated", "canon_mismatch"],
      };

      const result = validateChartFrontMatter(frontMatter);
      expect(result.valid).toBe(true);
    });

    it("accepts front-matter without optional fields", () => {
      const frontMatter = {
        chart_id: "CHART-2026-06-05-001",
        cluster_id: "POL-327",
        route: "src/medic",
        status: "active",
        related_charts: [],
        created: "2026-06-05T12:00:00Z",
        updated: "2026-06-05T12:00:00Z",
      };

      const result = validateChartFrontMatter(frontMatter);
      expect(result.valid).toBe(true);
    });
  });

  describe("validateChartSections", () => {
    it("accepts content with all required sections", () => {
      const content = REQUIRED_SECTIONS.map((s) => `## ${s}`).join("\n");
      const result = validateChartSections(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects content missing a required section", () => {
      const content = REQUIRED_SECTIONS.filter((s) => s !== "Problem")
        .map((s) => `## ${s}`)
        .join("\n");

      const result = validateChartSections(content);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required section: Problem");
    });

    it("rejects content missing multiple sections", () => {
      const content = "## Some Other Section\n\nContent here.";

      const result = validateChartSections(content);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(REQUIRED_SECTIONS.length);
    });

    it("accepts sections at level 1 or level 2 headings", () => {
      let content = "";
      REQUIRED_SECTIONS.forEach((s, i) => {
        content += `${i % 2 === 0 ? "#" : "##"} ${s}\n`;
      });

      const result = validateChartSections(content);
      expect(result.valid).toBe(true);
    });

    it("ignores extra whitespace in section headings", () => {
      const content = REQUIRED_SECTIONS.map((s) => `##  ${s}  `).join("\n");
      const result = validateChartSections(content);
      expect(result.valid).toBe(true);
    });
  });

  describe("validateChart", () => {
    const validChartContent = `---
chart_id: CHART-2026-06-05-001
cluster_id: POL-327
route: src/medic
status: active
related_charts: []
created: 2026-06-05T12:00:00Z
updated: 2026-06-05T12:00:00Z
---

## Problem

Problem description here.

## Symptoms

Symptoms here.

## Root Cause

Root cause here.

## Affected Files

File list here.

## Treatment

Treatment here.

## Validation

Validation here.

## Prevention

Prevention here.

## When To Read This Chart

When to read here.
`;

    it("accepts a valid chart with front-matter and sections", () => {
      const result = validateChart(validChartContent);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects chart without front-matter", () => {
      const content = validChartContent.split("---\n")[2];
      const result = validateChart(content);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("front-matter")),
      ).toBe(true);
    });

    it("rejects chart with invalid front-matter", () => {
      const content = `---
chart_id: INVALID
cluster_id: POL-327
route: src/medic
status: active
related_charts: []
created: 2026-06-05T12:00:00Z
updated: 2026-06-05T12:00:00Z
---

## Problem

Problem description here.

## Symptoms

Symptoms here.

## Root Cause

Root cause here.

## Affected Files

File list here.

## Treatment

Treatment here.

## Validation

Validation here.

## Prevention

Prevention here.

## When To Read This Chart

When to read here.
`;

      const result = validateChart(content);
      expect(result.valid).toBe(false);
    });

    it("rejects chart missing required sections", () => {
      const content = `---
chart_id: CHART-2026-06-05-001
cluster_id: POL-327
route: src/medic
status: active
related_charts: []
created: 2026-06-05T12:00:00Z
updated: 2026-06-05T12:00:00Z
---

## Problem

Problem description here.
`;

      const result = validateChart(content);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes("Missing required section")),
      ).toBe(true);
    });

    it("reports both front-matter and section errors when both are invalid", () => {
      const content = `---
chart_id: INVALID
cluster_id: POL-327
---

## Some Section

Content here.
`;

      const result = validateChart(content);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });
});