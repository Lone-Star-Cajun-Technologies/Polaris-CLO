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

function getIndent(line: string): number {
  let indent = 0;
  for (const char of line) {
    if (char === " " || char === "\t") {
      indent++;
    } else {
      break;
    }
  }
  return indent;
}

function splitTopLevel(value: string, separator: string): string[] {
  const openChars = ["[", "{"];
  const closeChars = ["]", "}"];
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (inString) {
      if (c === "\\") {
        current += c;
        if (i + 1 < value.length) {
          i++;
          current += value[i];
        }
        continue;
      }
      if (c === stringChar) {
        inString = false;
      }
      current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      current += c;
      continue;
    }
    if (openChars.includes(c)) {
      depth++;
    }
    if (closeChars.includes(c)) {
      depth = Math.max(0, depth - 1);
    }
    if (c === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }

  if (current.trim() !== "") {
    parts.push(current);
  }
  return parts;
}

function parseInlineValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "[]") {
    return [];
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const content = trimmed.slice(1, -1).trim();
    if (content === "") {
      return [];
    }
    return splitTopLevel(content, ",").map((part) => parseInlineValue(part));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const content = trimmed.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (content === "") {
      return obj;
    }
    for (const part of splitTopLevel(content, ",")) {
      const p = part.trim();
      if (p === "") {
        continue;
      }
      const colonIdx = p.indexOf(":");
      if (colonIdx === -1) {
        continue;
      }
      const key = p.slice(0, colonIdx).trim();
      const val = p.slice(colonIdx + 1).trim();
      obj[key] = parseInlineValue(val);
    }
    return obj;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function parseBlockList(
  lines: string[],
  start: number,
  listIndent: number,
): { list: unknown[]; nextIndex: number } {
  const list: unknown[] = [];
  let currentObject: Record<string, unknown> | null = null;
  let i = start;

  const pushCurrent = () => {
    if (currentObject) {
      list.push(currentObject);
      currentObject = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent !== listIndent) {
      if (currentObject && indent > listIndent) {
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx !== -1) {
          const key = trimmed.slice(0, colonIdx).trim();
          const value = trimmed.slice(colonIdx + 1).trim();
          currentObject[key] = parseInlineValue(value);
        }
        i++;
        continue;
      }
      break;
    }

    if (trimmed.startsWith("- ")) {
      pushCurrent();
      const item = trimmed.slice(2).trim();
      const colonIdx = item.indexOf(":");
      if (colonIdx === -1) {
        list.push(parseInlineValue(item));
      } else {
        currentObject = {};
        const key = item.slice(0, colonIdx).trim();
        const value = item.slice(colonIdx + 1).trim();
        currentObject[key] = parseInlineValue(value);
      }
      i++;
    } else if (trimmed === "-") {
      pushCurrent();
      list.push(null);
      i++;
    } else {
      break;
    }
  }

  pushCurrent();
  return { list, nextIndex: i };
}

function parseFrontMatter(raw: string): Record<string, unknown> {
  const lines = raw.split("\n");
  const frontMatter: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (value !== "") {
      frontMatter[key] = parseInlineValue(value);
      i++;
      continue;
    }

    i++;
    if (i < lines.length) {
      const nextLine = lines[i];
      if (nextLine.trim().startsWith("- ") || nextLine.trim() === "-") {
        const { list, nextIndex } = parseBlockList(lines, i, getIndent(nextLine));
        frontMatter[key] = list;
        i = nextIndex;
      } else {
        frontMatter[key] = "";
      }
    } else {
      frontMatter[key] = "";
    }
  }

  return frontMatter;
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

  const frontMatter = parseFrontMatter(frontMatterMatch[1]);

  const frontMatterResult = validateChartFrontMatter(frontMatter);
  frontMatterErrors.push(...frontMatterResult.errors);

  const sectionResult = validateChartSections(content);
  sectionErrors.push(...sectionResult.errors);

  return {
    valid: frontMatterErrors.length === 0 && sectionErrors.length === 0,
    errors: [...frontMatterErrors, ...sectionErrors],
  };
}