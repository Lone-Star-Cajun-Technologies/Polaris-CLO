import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { AdoptionPlan, AdoptionStep } from "./adoption-plan.js";

interface SmartDocsMigrationRecord {
  step_id: string;
  source_path: string;
  dest_path: string;
  migrated_at: string;
  migration_run_id: string;
  transport: "git mv" | "fs.rename" | "reconciled";
}

const COMPLETE_STATUSES = new Set(["completed", "skipped"]);

function isExcludedSourcePath(sourcePath: string): boolean {
  const normalized = sourcePath.replaceAll("\\", "/");
  const basenameOnly = basename(normalized);

  if (["README.md", "CHANGELOG.md", "LICENSE", "CONTRIBUTING.md"].includes(basenameOnly)) {
    return true;
  }

  if (
    normalized === "smartdocs" ||
    normalized.startsWith("smartdocs/") ||
    normalized.startsWith("test/") ||
    normalized.includes("/test/") ||
    normalized.startsWith("fixtures/") ||
    normalized.includes("/fixtures/") ||
    normalized.startsWith("__mocks__/") ||
    normalized.includes("/__mocks__/") ||
    normalized.startsWith("generated/") ||
    normalized.includes("/generated/") ||
    normalized.startsWith("dist/") ||
    normalized.includes("/dist/") ||
    normalized.startsWith("build/") ||
    normalized.includes("/build/") ||
    normalized.startsWith("coverage/") ||
    normalized.includes("/coverage/")
  ) {
    return true;
  }

  return false;
}

function loadPlan(repoRoot: string, fallback: AdoptionPlan): AdoptionPlan {
  const planPath = join(repoRoot, ".polaris", "adoption-plan.json");
  if (!existsSync(planPath)) {
    return fallback;
  }

  try {
    return JSON.parse(readFileSync(planPath, "utf-8")) as AdoptionPlan;
  } catch {
    return fallback;
  }
}

function savePlan(repoRoot: string, plan: AdoptionPlan): void {
  const planPath = join(repoRoot, ".polaris", "adoption-plan.json");
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
}

function loadExistingProvenance(repoRoot: string): Record<string, unknown> {
  const provenancePath = join(repoRoot, ".polaris", "adoption-provenance.json");
  if (!existsSync(provenancePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(provenancePath, "utf-8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through and rewrite a clean provenance file.
  }

  return {};
}

function saveProvenance(repoRoot: string, records: SmartDocsMigrationRecord[]): void {
  if (records.length === 0) {
    return;
  }

  const provenancePath = join(repoRoot, ".polaris", "adoption-provenance.json");
  mkdirSync(dirname(provenancePath), { recursive: true });
  const existing = loadExistingProvenance(repoRoot);
  const prior = Array.isArray(existing.smartdocs_migrations) ? existing.smartdocs_migrations : [];
  const updated = {
    ...existing,
    updated_at: new Date().toISOString(),
    smartdocs_migrations: [...prior, ...records],
  };

  writeFileSync(provenancePath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
}

function recordKey(record: Pick<SmartDocsMigrationRecord, "step_id" | "source_path" | "dest_path">): string {
  return `${record.step_id}:${record.source_path}:${record.dest_path}`;
}

function existingRecordKeys(repoRoot: string): Set<string> {
  const provenance = loadExistingProvenance(repoRoot);
  const records = Array.isArray(provenance.smartdocs_migrations) ? provenance.smartdocs_migrations : [];
  const keys = new Set<string>();

  for (const record of records) {
    if (
      typeof record === "object" &&
      record !== null &&
      !Array.isArray(record) &&
      typeof (record as Record<string, unknown>).step_id === "string" &&
      typeof (record as Record<string, unknown>).source_path === "string" &&
      typeof (record as Record<string, unknown>).dest_path === "string"
    ) {
      keys.add(
        recordKey({
          step_id: (record as Record<string, unknown>).step_id as string,
          source_path: (record as Record<string, unknown>).source_path as string,
          dest_path: (record as Record<string, unknown>).dest_path as string,
        }),
      );
    }
  }

  return keys;
}

function normalizeStatus(step: AdoptionStep, status: AdoptionStep["status"], completedAt?: string): AdoptionStep {
  return {
    ...step,
    status,
    completed_at: completedAt ?? step.completed_at,
    error: status === "completed" || status === "skipped" ? undefined : step.error,
  };
}

const SMARTDOCS_BUNDLE_INDEX_CONTENT = `---\nokf_version: "0.1"\n---\n\n# SmartDocs — Polaris Cognition Bundle\n\n# Governance\n\n- [Docs authority model](specs/active/docs-authority-model.md)\n- [Doctrine](doctrine/active/)\n\n# Routes\n\n<!-- Routes placeholder: dynamic file-routes.json generation deferred. -->\n`;

const SMARTDOCS_BUNDLE_LOG_CONTENT = "# SmartDocs — Change Log\n";

export function scaffoldBundleRoot(repoRoot: string): void {
  const smartdocsDir = join(repoRoot, "smartdocs");
  mkdirSync(smartdocsDir, { recursive: true });

  const indexPath = join(smartdocsDir, "index.md");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, SMARTDOCS_BUNDLE_INDEX_CONTENT, "utf-8");
  }

  const logPath = join(smartdocsDir, "log.md");
  if (!existsSync(logPath)) {
    writeFileSync(logPath, SMARTDOCS_BUNDLE_LOG_CONTENT, "utf-8");
  }
}

export function migrateSmartDocs(plan: AdoptionPlan, repoRoot = resolve(process.cwd())): Promise<void> {
  const effectivePlan = loadPlan(repoRoot, plan);
  const provenanceRecords: SmartDocsMigrationRecord[] = [];
  const seenRecords = existingRecordKeys(repoRoot);
  const now = new Date().toISOString();

  for (let index = 0; index < effectivePlan.steps.length; index += 1) {
    const step = effectivePlan.steps[index];
    if (step.category !== "smartdocs-migrate" || COMPLETE_STATUSES.has(step.status)) {
      continue;
    }

    if (step.routing !== undefined && step.routing !== "candidate") {
      effectivePlan.steps[index] = {
        ...step,
        status: "skipped",
        completed_at: now,
        error: `routing not candidate: ${step.routing}`,
      };
      continue;
    }

    const sourcePath = step.source_path ?? "";
    const destPath =
      step.dest_path ?? `smartdocs/raw/${basename(sourcePath || `step-${step.order}.md`)}`;

    if (!sourcePath) {
      effectivePlan.steps[index] = normalizeStatus(step, "skipped", now);
      continue;
    }

    if (isExcludedSourcePath(sourcePath)) {
      effectivePlan.steps[index] = normalizeStatus(step, "skipped", now);
      continue;
    }

    const sourceAbs = join(repoRoot, sourcePath);
    const destAbs = join(repoRoot, destPath);
    mkdirSync(dirname(destAbs), { recursive: true });

    if (!existsSync(sourceAbs)) {
      if (existsSync(destAbs)) {
        effectivePlan.steps[index] = normalizeStatus(step, "completed", step.completed_at ?? now);
        const record = {
          step_id: step.step_id,
          source_path: sourcePath,
          dest_path: destPath,
          migrated_at: step.completed_at ?? now,
          migration_run_id: effectivePlan.plan_id,
          transport: "reconciled" as const,
        };
        if (!seenRecords.has(recordKey(record))) {
          provenanceRecords.push(record);
          seenRecords.add(recordKey(record));
        }
      } else {
        effectivePlan.steps[index] = {
          ...step,
          status: "skipped",
          completed_at: now,
          error: `source missing: ${sourcePath}`,
        };
      }
      continue;
    }

    let transport: SmartDocsMigrationRecord["transport"] = "git mv";
    try {
      execFileSync("git", ["mv", "--", sourcePath, destPath], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } catch {
      process.stdout.write(
        `SmartDocs git mv failed for ${sourcePath}; falling back to fs.rename().\n`,
      );
      renameSync(sourceAbs, destAbs);
      transport = "fs.rename";
    }

    const record = {
      step_id: step.step_id,
      source_path: sourcePath,
      dest_path: destPath,
      migrated_at: now,
      migration_run_id: effectivePlan.plan_id,
      transport,
    };

    effectivePlan.steps[index] = normalizeStatus(step, "completed", now);
    if (!seenRecords.has(recordKey(record))) {
      provenanceRecords.push(record);
      seenRecords.add(recordKey(record));
    }
  }

  scaffoldBundleRoot(repoRoot);
  savePlan(repoRoot, effectivePlan);
  saveProvenance(repoRoot, provenanceRecords);
  Object.assign(plan, effectivePlan);
  return Promise.resolve();
}
