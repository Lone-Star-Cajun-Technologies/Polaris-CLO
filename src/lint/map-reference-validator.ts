import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface LintViolation {
  file: string;
  line: number;
  message: string;
  rule: string;
}

export interface LintResult {
  violations: LintViolation[];
  filesChecked: number;
}

/**
 * Patterns that indicate broad context preload in skill chain files.
 * These patterns violate the Navigation Before Retrieval doctrine.
 */
const BROAD_PRELOAD_PATTERNS = [
  /read\s+all\s+doctrine/i,
  /load\s+all\s+charts/i,
  /preload\s+(all\s+)?(linked\s+)?(docs|documents|doctrine|charts)/i,
];

export function validateSkillChainFile(filePath: string): LintViolation[] {
  const violations: LintViolation[] = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      for (const pattern of BROAD_PRELOAD_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({
            file: filePath,
            line: lineNumber,
            message:
              "[navigation-before-retrieval] Skill chain instructs broad context preload — use targeted retrieval instead",
            rule: "navigation-before-retrieval",
          });
          break; // Only report one violation per line
        }
      }
    }
  } catch (error) {
    // If we can't read the file, skip it
    console.warn(`Warning: Could not read file ${filePath}: ${error}`);
  }

  return violations;
}

export function validateSkillChainDirectory(
  dirPath: string,
): LintResult {
  const violations: LintViolation[] = [];
  let filesChecked = 0;

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recursively check subdirectories
        const result = validateSkillChainDirectory(fullPath);
        violations.push(...result.violations);
        filesChecked += result.filesChecked;
      } else if (entry.name === "chain.md") {
        // Check skill chain files
        filesChecked++;
        violations.push(...validateSkillChainFile(fullPath));
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not read directory ${dirPath}: ${error}`);
  }

  return { violations, filesChecked };
}

export function validateMapReferences(repoRoot: string): LintResult {
  const skillsDir = join(repoRoot, ".polaris", "skills");
  return validateSkillChainDirectory(skillsDir);
}