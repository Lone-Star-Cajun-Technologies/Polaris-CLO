import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { LocalGraph } from "../../local-graph.js";
import { executionGraphV2Schema } from "../../schema.js";
import type { ExecutionCluster, ExecutionGraphV2, ExecutionNode } from "../../types.js";

const SECTION_HEADERS = {
  objective: new Set(["objective"]),
  scope: new Set(["scope", "expected code areas", "code areas", "files to change", "files"]),
  validation: new Set(["validation", "validation commands", "test commands", "verify"]),
  children: new Set(["children"]),
};

function slugifySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = markdown.split(/^##\s+/m);
  for (const part of parts) {
    const lineBreak = part.indexOf("\n");
    if (lineBreak === -1) continue;
    const header = part.slice(0, lineBreak).trim().toLowerCase();
    const content = part.slice(lineBreak + 1);
    sections.set(header, content);
  }
  return sections;
}

function parseList(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => /^\s*[-*]\s+/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

function readSectionText(sections: Map<string, string>, headers: Set<string>): string {
  for (const [header, content] of sections) {
    if (headers.has(header)) {
      return content.trim();
    }
  }
  return "";
}

function readSectionList(sections: Map<string, string>, headers: Set<string>): string[] {
  for (const [header, content] of sections) {
    if (headers.has(header)) {
      return parseList(content);
    }
  }
  return [];
}

function toChildId(index: number): string {
  return `spec-child-${String(index).padStart(2, "0")}`;
}

function createChildBody(title: string, scope: string[], validation: string[]): string {
  const lines: string[] = [
    "## Objective",
    title,
    "",
  ];

  if (scope.length > 0) {
    lines.push("## Scope");
    for (const scopeEntry of scope) {
      lines.push(`- ${scopeEntry}`);
    }
    lines.push("");
  }

  if (validation.length > 0) {
    lines.push("## Validation");
    for (const command of validation) {
      lines.push(`- ${command}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export class SpecAdapter {
  async syncIn(specPath: string): Promise<LocalGraph> {
    const raw = await readFile(specPath, "utf-8");
    const sections = parseSections(raw);
    const objective = readSectionText(sections, SECTION_HEADERS.objective);
    const scope = readSectionList(sections, SECTION_HEADERS.scope);
    const validation = readSectionList(sections, SECTION_HEADERS.validation);
    const childTitles = readSectionList(sections, SECTION_HEADERS.children);

    if (!objective) {
      throw new Error("Spec file is missing required section: ## Objective");
    }
    if (childTitles.length === 0) {
      throw new Error("Spec file is missing required section content: ## Children");
    }

    const baseName = basename(specPath, extname(specPath));
    const clusterSlug = slugifySegment(baseName) || "cluster";
    const clusterId = `spec-${clusterSlug}`;
    const rootNodeId = clusterId;

    const nodes: Record<string, ExecutionNode> = {};
    const dependencies: Record<string, string[]> = {};
    const children: string[] = [];

    nodes[rootNodeId] = {
      id: rootNodeId,
      title: objective,
      status: "Todo",
      body: raw.trim(),
    };

    for (const [index, childTitle] of childTitles.entries()) {
      const childId = toChildId(index + 1);
      children.push(childId);
      nodes[childId] = {
        id: childId,
        title: childTitle,
        status: "Todo",
        sessionType: "implement",
        body: createChildBody(childTitle, scope, validation),
      };
    }

    const cluster: ExecutionCluster = {
      id: clusterId,
      title: objective,
      cluster_root: rootNodeId,
      children,
    };

    const graph: ExecutionGraphV2 = executionGraphV2Schema.parse({
      schemaVersion: "v2",
      source: {
        id: specPath,
        type: "spec",
        analysis: {
          id: "spec-sync",
          doc: objective,
        },
      },
      nodes,
      dependencies,
      clusters: {
        [clusterId]: cluster,
      },
      activeCluster: clusterId,
    });

    return LocalGraph.fromGraph(graph);
  }
}
