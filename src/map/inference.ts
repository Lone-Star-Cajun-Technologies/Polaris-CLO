import { readFileSync, existsSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import type { FileRouteEntry } from "./atlas.js";
import type { PolarisConfig } from "../config/schema.js";

export interface InferenceResult {
  domain: string;
  route: string;
  taskchain: string;
  confidence: number;
  tags: string[];
}

type KnownRoutes = Record<string, Pick<FileRouteEntry, "domain" | "route" | "taskchain">>;

export function inferRoute(
  filePath: string,
  repoRoot: string,
  config: Required<PolarisConfig>,
  knownRoutes: KnownRoutes,
  branchName: string,
): InferenceResult {
  let confidence = 0;
  let domain = "";
  let route = "";
  let taskchain = "";
  const tags: string[] = [];

  // Signal 1: file path prefix matching sourceRoots
  for (const sourceRoot of (config.repo.sourceRoots ?? [])) {
    const prefix = sourceRoot.endsWith("/") ? sourceRoot : `${sourceRoot}/`;
    if (filePath.startsWith(prefix)) {
      const rest = filePath.slice(prefix.length);
      const subdir = rest.split("/")[0];
      if (subdir && rest.includes("/")) {
        domain = subdir;
        // Route identity follows the file's own containing directory, not just the
        // top-level domain subdir — otherwise nested folders (e.g. src/runtime/continuation)
        // incorrectly report the parent domain's route (e.g. src/runtime).
        route = dirname(filePath).replace(/\\/g, "/");
        taskchain = `polaris-${subdir}`;
        confidence += 0.85;
        tags.push(subdir);
      }
      break;
    }
  }

  // Signal 2: nearby mapped files in same directory (corroborating)
  if (domain) {
    const dir = dirname(filePath);
    const nearbyAgreement = Object.entries(knownRoutes).some(
      ([p, e]) => dirname(p) === dir && e.domain === domain,
    );
    if (nearbyAgreement) {
      confidence = Math.min(confidence + 0.05, 0.99);
    }
  }

  // Signal 3: branch name contains domain slug (corroborating)
  if (domain && branchName) {
    const slugParts = branchName.toLowerCase().split(/[-/]/);
    if (slugParts.includes(domain.toLowerCase())) {
      confidence = Math.min(confidence + 0.05, 0.99);
    }
  }

  // Signal 4: file imports from paths in the same domain (corroborating)
  if (domain) {
    try {
      const fullPath = resolve(repoRoot, filePath);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, "utf-8");
        const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const sameDomainImport = new RegExp(`from\\s+['"](?:\\.\\.?/)*${escapedDomain}/`);
        if (sameDomainImport.test(content)) {
          confidence = Math.min(confidence + 0.05, 0.99);
        }
      }
    } catch {
      // ignore read errors
    }
  }

  // Tags: entry-point and test detection
  const file = basename(filePath);
  if (file === "index.ts" || file === "index.js") tags.push("entry-point");
  if (file.includes(".test.") || file.includes(".spec.")) tags.push("test");

  return {
    domain: domain || "unknown",
    route: route || filePath,
    taskchain: taskchain || "polaris-core",
    confidence,
    tags,
  };
}
