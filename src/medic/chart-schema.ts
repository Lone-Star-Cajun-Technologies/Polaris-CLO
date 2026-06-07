import { z } from "zod";

/**
 * Supported chart relationship types
 */
export const ChartRelationshipType = z.enum([
  "same_failure",
  "edge_case_of",
  "regression_of",
  "caused_by",
  "fixed_by",
  "supersedes",
  "duplicate_of",
]);

export type ChartRelationshipType = z.infer<typeof ChartRelationshipType>;

/**
 * Chart relationship reference
 */
export const ChartRelationship = z.object({
  chart_id: z.string().regex(/^CHART-\d{4}-\d{2}-\d{2}-\d{3}$/, {
    message: "chart_id must match format CHART-YYYY-MM-DD-NNN",
  }),
  relationship: ChartRelationshipType,
});

export type ChartRelationship = z.infer<typeof ChartRelationship>;

/**
 * Chart front-matter schema
 */
export const ChartFrontMatter = z.object({
  chart_id: z.string().regex(/^CHART-\d{4}-\d{2}-\d{2}-\d{3}$/, {
    message: "chart_id must match format CHART-YYYY-MM-DD-NNN",
  }),
  cluster_id: z.string().min(1),
  route: z.string().min(1),
  status: z.string().min(1),
  related_charts: z.array(ChartRelationship).optional(),
  created: z.string().datetime(),
  updated: z.string().datetime(),
  drift_observations: z.array(z.string()).optional(),
});

export type ChartFrontMatter = z.infer<typeof ChartFrontMatter>;

/**
 * Required section headings in a chart
 */
export const REQUIRED_SECTIONS = [
  "Problem",
  "Symptoms",
  "Root Cause",
  "Affected Files",
  "Treatment",
  "Validation",
  "Prevention",
  "When To Read This Chart",
] as const;

/**
 * Validation result for a chart
 */
export interface ChartValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate chart front-matter
 */
export function validateChartFrontMatter(
  frontMatter: unknown,
): ChartValidationResult {
  const result = ChartFrontMatter.safeParse(frontMatter);

  if (!result.success) {
    return {
      valid: false,
      errors: result.error.errors.map(
        (e) => `${e.path.join(".")}: ${e.message}`,
      ),
    };
  }

  return { valid: true, errors: [] };
}

/**
 * Check if a markdown content contains all required section headings
 */
export function validateChartSections(content: string): ChartValidationResult {
  const errors: string[] = [];

  for (const section of REQUIRED_SECTIONS) {
    // Check for section heading (## at level 2, or # at level 1)
    const pattern = new RegExp(`^#{1,2}\\s*${section}\\s*$`, "m");
    if (!pattern.test(content)) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a complete chart (front-matter and sections)
 */
export function validateChart(content: string): ChartValidationResult {
  const frontMatterErrors: string[] = [];
  const sectionErrors: string[] = [];

  // Extract front-matter
  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontMatterMatch) {
    return {
      valid: false,
      errors: ["Chart must have YAML front-matter delimited by ---"],
    };
  }

  // Parse YAML front-matter (simple key:value parsing)
  const frontMatter: Record<string, unknown> = {};
  const frontMatterLines = frontMatterMatch[1].split("\n");
  for (const line of frontMatterLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    // Remove quotes if present
    const cleanedValue = value.replace(/^["']|["']$/g, "");

    // Handle arrays (simple comma-separated for now)
    if (cleanedValue.startsWith("[") && cleanedValue.endsWith("]")) {
      const arrayContent = cleanedValue.slice(1, -1);
      if (arrayContent.trim() === "") {
        frontMatter[key] = [];
      } else {
        frontMatter[key] = arrayContent.split(",").map((s) => s.trim());
      }
    } else if (key === "related_charts") {
      // Special handling for related_charts array of objects
      // This is a simplified parser - in production you'd use a proper YAML parser
      frontMatter[key] = [];
    } else {
      frontMatter[key] = cleanedValue;
    }
  }

  const frontMatterResult = validateChartFrontMatter(frontMatter);
  frontMatterErrors.push(...frontMatterResult.errors);

  const sectionResult = validateChartSections(content);
  sectionErrors.push(...sectionResult.errors);

  return {
    valid: frontMatterErrors.length === 0 && sectionErrors.length === 0,
    errors: [...frontMatterErrors, ...sectionErrors],
  };
}