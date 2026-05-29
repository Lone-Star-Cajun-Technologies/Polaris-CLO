import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config/loader.js";
import { SECRET_PATTERNS } from "../ignore/defaults.js";
import {
  readFileRoutes,
  readNeedsReview,
  readExemptions,
  writeFileRoutes,
  writeNeedsReview,
  VALID_ROLE_OWNERS,
} from "./atlas.js";

const SECRET_REGEXES = SECRET_PATTERNS.map(
  (p) => new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"),
);

function isSecretPath(filePath: string): boolean {
  const parts = filePath.split("/");
  const base = parts[parts.length - 1]!;
  return SECRET_REGEXES.some((re) => re.test(base) || re.test(filePath));
}

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

export interface ValidationResult {
  hasError: boolean;
  indexed: number;
  stale: string[];
  missing: string[];
  sensitive: string[];
  conflicted: string[];
  needsReviewCount: number;
  coveragePct: number;
  invalidRoleOwner: string[];
}

export function runMapValidate(
  repoRoot: string,
  staleThresholdDays: number,
  fixPath?: string,
): ValidationResult {
  const config = loadConfig(repoRoot);
  const outputPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const confidenceThreshold = config.map.confidenceThreshold ?? 0.75;

  const routes = readFileRoutes(outputPath);
  const needsReview = readNeedsReview(outputPath);
  const exemptions = readExemptions(outputPath);

  // --fix: show current entry and remove if file is missing
  if (fixPath) {
    const entry = routes[fixPath] ?? needsReview[fixPath];
    if (entry) {
      console.log(`Current entry for ${fixPath}:`);
      console.log(JSON.stringify(entry, null, 2));
      if (!existsSync(resolve(repoRoot, fixPath))) {
        if (routes[fixPath]) {
          const updated = { ...routes };
          delete updated[fixPath];
          writeFileRoutes(outputPath, updated);
          console.log(`Removed missing entry from routes: ${fixPath}`);
        } else if (needsReview[fixPath]) {
          const updated = { ...needsReview };
          delete updated[fixPath];
          writeNeedsReview(outputPath, updated);
          console.log(`Removed missing entry from needs-review: ${fixPath}`);
        }
      }
    } else {
      console.log(`No entry found for: ${fixPath}`);
    }
    return { hasError: false, indexed: 0, stale: [], missing: [], sensitive: [], conflicted: [], needsReviewCount: 0, coveragePct: 0, invalidRoleOwner: [] };
  }

  const stale: string[] = [];
  const missing: string[] = [];
  const sensitive: string[] = [];
  const conflicted: string[] = [];
  const invalidRoleOwner: string[] = [];

  // Route conflict detection: route → set of domains seen
  const routeToDomains = new Map<string, Set<string>>();
  const routeToFiles = new Map<string, string[]>();

  // Combine routes and needsReview for validation checks
  const allEntries = [...Object.entries(routes), ...Object.entries(needsReview)];

  for (const [filePath, entry] of allEntries) {
    // 2. Missing source files
    if (!existsSync(resolve(repoRoot, filePath))) {
      missing.push(filePath);
      continue;
    }

    // 1. Stale entries
    if (daysSince(entry.last_updated) > staleThresholdDays) {
      stale.push(filePath);
    }

    // 4. Sensitive pattern matches in atlas
    if (isSecretPath(filePath)) {
      sensitive.push(filePath);
    }

    // 6. role_owner validation: present and a known value
    if (entry.role_owner !== undefined) {
      if (!(VALID_ROLE_OWNERS as readonly string[]).includes(entry.role_owner)) {
        invalidRoleOwner.push(filePath);
      }
    }

    // 5. Conflicted routes: same route claimed by different domains
    const domains = routeToDomains.get(entry.route) ?? new Set<string>();
    domains.add(entry.domain);
    routeToDomains.set(entry.route, domains);
    const files = routeToFiles.get(entry.route) ?? [];
    files.push(filePath);
    routeToFiles.set(entry.route, files);
  }

  for (const [route, domains] of routeToDomains) {
    if (domains.size > 1) {
      conflicted.push(...(routeToFiles.get(route) ?? []));
    }
  }

  // 3. Low-confidence (needs-review count)
  const needsReviewCount = Object.keys(needsReview).length;

  // Coverage: indexed / (indexed + needs-review + tracked-not-indexed)
  // Only count routes for indexedCount, excluding missing files
  const indexedCount = Object.keys(routes).length - missing.filter(f => routes[f]).length;
  const trackedCount = Object.keys(exemptions).length;
  const total = indexedCount + needsReviewCount + trackedCount;
  const coveragePct = total > 0 ? Math.round((indexedCount / total) * 100 * 10) / 10 : 0;

  // Output
  const successMark = "✓";
  const okMark = "✓";
  const warnMark = "⚠";
  const errMark = "✗";

  console.log(`${okMark} ${indexedCount} indexed files validated`);

  if (stale.length > 0) {
    console.log(`${warnMark} ${stale.length} stale entries (older than ${staleThresholdDays}d): ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? "..." : ""}`);
  }

  for (const f of missing) {
    console.log(`${errMark} 1 missing source file: ${f} (was indexed, file deleted)`);
  }

  if (sensitive.length > 0) {
    console.log(`${errMark} HIGH: ${sensitive.length} sensitive file(s) in atlas: ${sensitive.join(", ")}`);
  } else {
    console.log(`${successMark} HIGH: 0 sensitive files in atlas`);
  }

  if (needsReviewCount > 0) {
    console.log(`${warnMark} ${needsReviewCount} files in needs-review queue`);
  }

  if (conflicted.length > 0) {
    console.log(`${warnMark} ${conflicted.length} conflicted route entries: ${conflicted.slice(0, 3).join(", ")}${conflicted.length > 3 ? "..." : ""}`);
  }

  if (invalidRoleOwner.length > 0) {
    console.log(`${errMark} ${invalidRoleOwner.length} entries with invalid role_owner value: ${invalidRoleOwner.slice(0, 3).join(", ")}${invalidRoleOwner.length > 3 ? "..." : ""}`);
  }

  // Low-confidence entries warning
  const lowConfidence = Object.entries(routes).filter(([, e]) => e.confidence < confidenceThreshold);
  if (lowConfidence.length > 0) {
    console.log(`${warnMark} ${lowConfidence.length} indexed entries below confidence threshold`);
  }

  console.log(`\nCoverage: ${coveragePct}% (${indexedCount} / ${total} non-ignored files)`);

  const hasError = missing.length > 0 || sensitive.length > 0 || invalidRoleOwner.length > 0;

  return { hasError, indexed: indexedCount, stale, missing, sensitive, conflicted, needsReviewCount, coveragePct, invalidRoleOwner };
}
