export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => isString(v));
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export function validateConfig(config: unknown): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!isPlainObject(config)) {
    result.valid = false;
    result.errors.push("Config must be an object");
    return result;
  }

  // version
  if ("version" in config && config.version !== undefined) {
    if (!isString(config.version)) {
      result.valid = false;
      result.errors.push("version must be a string");
    }
  }

  // repo
  if ("repo" in config && config.repo !== undefined) {
    if (!isPlainObject(config.repo)) {
      result.valid = false;
      result.errors.push("repo must be an object");
    } else {
      if ("sourceRoots" in config.repo && config.repo.sourceRoots !== undefined) {
        if (!isStringArray(config.repo.sourceRoots)) {
          result.valid = false;
          result.errors.push("repo.sourceRoots must be an array of strings");
        }
      }
      if ("docsRoots" in config.repo && config.repo.docsRoots !== undefined) {
        if (!isStringArray(config.repo.docsRoots)) {
          result.valid = false;
          result.errors.push("repo.docsRoots must be an array of strings");
        }
      }
      if ("taskchainRoots" in config.repo && config.repo.taskchainRoots !== undefined) {
        if (!isStringArray(config.repo.taskchainRoots)) {
          result.valid = false;
          result.errors.push("repo.taskchainRoots must be an array of strings");
        }
      }
      if ("generatedRoots" in config.repo && config.repo.generatedRoots !== undefined) {
        if (!isStringArray(config.repo.generatedRoots)) {
          result.valid = false;
          result.errors.push("repo.generatedRoots must be an array of strings");
        }
      }
      if ("sidecarOutputPath" in config.repo && config.repo.sidecarOutputPath !== undefined) {
        if (!isString(config.repo.sidecarOutputPath)) {
          result.valid = false;
          result.errors.push("repo.sidecarOutputPath must be a string");
        }
      }
      if ("name" in config.repo && config.repo.name !== undefined) {
        if (!isString(config.repo.name)) {
          result.valid = false;
          result.errors.push("repo.name must be a string");
        }
      }
    }
  }

  // map
  if ("map" in config && config.map !== undefined) {
    if (!isPlainObject(config.map)) {
      result.valid = false;
      result.errors.push("map must be an object");
    } else {
      if ("confidenceThreshold" in config.map && config.map.confidenceThreshold !== undefined) {
        if (!isNumber(config.map.confidenceThreshold) || !inRange(config.map.confidenceThreshold, 0, 1)) {
          result.valid = false;
          result.errors.push("map.confidenceThreshold must be a number between 0 and 1");
        }
      }
      if ("autoWriteAbove" in config.map && config.map.autoWriteAbove !== undefined) {
        if (!isNumber(config.map.autoWriteAbove) || !inRange(config.map.autoWriteAbove, 0, 1)) {
          result.valid = false;
          result.errors.push("map.autoWriteAbove must be a number between 0 and 1");
        }
      }
      if ("reviewRequiredBelow" in config.map && config.map.reviewRequiredBelow !== undefined) {
        if (!isNumber(config.map.reviewRequiredBelow) || !inRange(config.map.reviewRequiredBelow, 0, 1)) {
          result.valid = false;
          result.errors.push("map.reviewRequiredBelow must be a number between 0 and 1");
        }
      }
      if ("inferenceRules" in config.map && config.map.inferenceRules !== undefined) {
        if (!isStringArray(config.map.inferenceRules)) {
          result.valid = false;
          result.errors.push("map.inferenceRules must be an array of strings");
        }
      }
      if ("onLowConfidence" in config.map && config.map.onLowConfidence !== undefined) {
        if (!isString(config.map.onLowConfidence) || !["warn", "fail"].includes(config.map.onLowConfidence)) {
          result.valid = false;
          result.errors.push('map.onLowConfidence must be either "warn" or "fail"');
        }
      }
    }
  }

  // loop
  if ("loop" in config && config.loop !== undefined) {
    if (!isPlainObject(config.loop)) {
      result.valid = false;
      result.errors.push("loop must be an object");
    } else {
      if ("bootstrapOutputPath" in config.loop && config.loop.bootstrapOutputPath !== undefined) {
        if (!isString(config.loop.bootstrapOutputPath)) {
          result.valid = false;
          result.errors.push("loop.bootstrapOutputPath must be a string");
        }
      }
      if ("analyzeImplBoundaryEnforced" in config.loop && config.loop.analyzeImplBoundaryEnforced !== undefined) {
        if (!isBoolean(config.loop.analyzeImplBoundaryEnforced)) {
          result.valid = false;
          result.errors.push("loop.analyzeImplBoundaryEnforced must be a boolean");
        }
      }
      if ("allowBranchDivergence" in config.loop && config.loop.allowBranchDivergence !== undefined) {
        if (!isBoolean(config.loop.allowBranchDivergence)) {
          result.valid = false;
          result.errors.push("loop.allowBranchDivergence must be a boolean");
        }
      }
      if ("sessionTerminationMode" in config.loop && config.loop.sessionTerminationMode !== undefined) {
        if (!isString(config.loop.sessionTerminationMode) || !["emit-marker", "exit-0"].includes(config.loop.sessionTerminationMode)) {
          result.valid = false;
          result.errors.push('loop.sessionTerminationMode must be either "emit-marker" or "exit-0"');
        }
      }
    }
  }

  // execution
  if ("execution" in config && config.execution !== undefined) {
    if (!isPlainObject(config.execution)) {
      result.valid = false;
      result.errors.push("execution must be an object");
    } else {
      if ("adapter" in config.execution && config.execution.adapter !== undefined) {
        if (
          !isString(config.execution.adapter) ||
          !["agent-subtask", "terminal-cli", "ci", "ssh", "remote-worker", "cross-agent"].includes(config.execution.adapter)
        ) {
          result.valid = false;
          result.errors.push("execution.adapter must be one of agent-subtask, terminal-cli, ci, ssh, remote-worker, cross-agent");
        }
      }
      if ("allowCrossAgentFallback" in config.execution && config.execution.allowCrossAgentFallback !== undefined) {
        if (!isBoolean(config.execution.allowCrossAgentFallback)) {
          result.valid = false;
          result.errors.push("execution.allowCrossAgentFallback must be a boolean");
        }
      }
    }
  }

  // finalize
  if ("finalize" in config && config.finalize !== undefined) {
    if (!isPlainObject(config.finalize)) {
      result.valid = false;
      result.errors.push("finalize must be an object");
    } else {
      if ("targetBranch" in config.finalize && config.finalize.targetBranch !== undefined) {
        if (!isString(config.finalize.targetBranch)) {
          result.valid = false;
          result.errors.push("finalize.targetBranch must be a string");
        }
      }
      if ("prDraft" in config.finalize && config.finalize.prDraft !== undefined) {
        if (!isBoolean(config.finalize.prDraft)) {
          result.valid = false;
          result.errors.push("finalize.prDraft must be a boolean");
        }
      }
      if ("runChecks" in config.finalize && config.finalize.runChecks !== undefined) {
        if (!isStringArray(config.finalize.runChecks)) {
          result.valid = false;
          result.errors.push("finalize.runChecks must be an array of strings");
        }
      }
      if ("requireMapValidation" in config.finalize && config.finalize.requireMapValidation !== undefined) {
        if (!isBoolean(config.finalize.requireMapValidation)) {
          result.valid = false;
          result.errors.push("finalize.requireMapValidation must be a boolean");
        }
      }
      if ("requireSchemaValidation" in config.finalize && config.finalize.requireSchemaValidation !== undefined) {
        if (!isBoolean(config.finalize.requireSchemaValidation)) {
          result.valid = false;
          result.errors.push("finalize.requireSchemaValidation must be a boolean");
        }
      }
      if ("archiveRunSnapshot" in config.finalize && config.finalize.archiveRunSnapshot !== undefined) {
        if (!isBoolean(config.finalize.archiveRunSnapshot)) {
          result.valid = false;
          result.errors.push("finalize.archiveRunSnapshot must be a boolean");
        }
      }
    }
  }

  // tracker
  if ("tracker" in config && config.tracker !== undefined) {
    if (!isPlainObject(config.tracker)) {
      result.valid = false;
      result.errors.push("tracker must be an object");
    } else {
      if ("linear" in config.tracker && config.tracker.linear !== undefined) {
        if (!isPlainObject(config.tracker.linear)) {
          result.valid = false;
          result.errors.push("tracker.linear must be an object");
        } else {
          if ("enabled" in config.tracker.linear && config.tracker.linear.enabled !== undefined) {
            if (!isBoolean(config.tracker.linear.enabled)) {
              result.valid = false;
              result.errors.push("tracker.linear.enabled must be a boolean");
            }
          }
          if ("teamId" in config.tracker.linear && config.tracker.linear.teamId !== undefined) {
            if (!isString(config.tracker.linear.teamId)) {
              result.valid = false;
              result.errors.push("tracker.linear.teamId must be a string");
            }
          }
          if ("projectId" in config.tracker.linear && config.tracker.linear.projectId !== undefined) {
            if (!isString(config.tracker.linear.projectId)) {
              result.valid = false;
              result.errors.push("tracker.linear.projectId must be a string");
            }
          }
        }
      }
    }
  }

  // integrations
  if ("integrations" in config && config.integrations !== undefined) {
    if (!isPlainObject(config.integrations)) {
      result.valid = false;
      result.errors.push("integrations must be an object");
    } else {
      if ("github" in config.integrations && config.integrations.github !== undefined) {
        if (!isPlainObject(config.integrations.github)) {
          result.valid = false;
          result.errors.push("integrations.github must be an object");
        } else {
          if ("owner" in config.integrations.github && config.integrations.github.owner !== undefined) {
            if (!isString(config.integrations.github.owner)) {
              result.valid = false;
              result.errors.push("integrations.github.owner must be a string");
            }
          }
          if ("repo" in config.integrations.github && config.integrations.github.repo !== undefined) {
            if (!isString(config.integrations.github.repo)) {
              result.valid = false;
              result.errors.push("integrations.github.repo must be a string");
            }
          }
        }
      }
    }
  }

  // unknown top-level fields -> warnings
  const knownKeys = new Set([
    "version",
    "repo",
    "map",
    "loop",
    "finalize",
    "tracker",
    "integrations",
  ]);
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) {
      result.warnings.push(`Unknown config field: "${key}"`);
    }
  }

  return result;
}
