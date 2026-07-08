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

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
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

const SUPPORTED_COMPACTION_PROVIDER_IDS = ["caveman", "gitnexus"] as const;
const SUPPORTED_GRAPH_INVALIDATION_TRIGGERS = [
  "repo-change",
  "config-change",
] as const;
const SUPPORTED_EXECUTION_ROLES = [
  "orchestrator",
  "startup",
  "worker",
  "foreman",
  "analyst",
  "analysis",
  "repair",
  "librarian",
  "docs",
  "finalizer",
] as const;
const SUPPORTED_EXECUTION_ADAPTERS = [
  "agent-subtask",
  "terminal-cli",
  "ci",
  "ssh",
  "remote-worker",
  "cross-agent",
] as const;
const SUPPORTED_ROUTER_CAPABILITIES = [
  "orchestration",
  "analysis",
  "implementation",
  "repair",
  "docs",
  "finalization",
] as const;
const SUPPORTED_ROUTER_TASK_TYPES = [
  "startup",
  "analyze",
  "impl",
  "repair",
  "docs",
  "finalize",
] as const;
const SUPPORTED_ROUTER_TRUST_TIERS = ["sandbox", "standard", "trusted"] as const;
const SUPPORTED_ROUTER_COST_TIERS = ["low", "medium", "high"] as const;
const SUPPORTED_ROUTER_QUOTA_POLICIES = [
  "best-effort",
  "rate-limited",
  "reserved",
] as const;
const SUPPORTED_LIFECYCLE_STATES = [
  "backlog",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
  "no_status_change",
] as const;
const SUPPORTED_QC_TRIGGERS = ["pr", "completed-cluster", "child"] as const;
const SUPPORTED_QC_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const SUPPORTED_QC_PROVIDER_MODES = ["local", "pr", "metrics-import"] as const;
const SUPPORTED_QC_AUTO_FIX_POLICIES = ["disabled", "dry-run", "apply"] as const;
const SUPPORTED_QC_REPAIR_ROUTING_POLICIES = ["block", "route", "follow-up", "log"] as const;
const SUPPORTED_QC_PROVIDER_CAPABILITIES = [
  "diff-review",
  "pr-review",
  "result-parsing",
  "auto-fix",
  "metrics-import",
] as const;
const SUPPORTED_QC_OUTPUT_FORMATS = ["json", "jsonl", "sarif", "generic"] as const;
const SUPPORTED_QC_FAILURE_ACTIONS = ["fail", "fallback", "ignore", "block"] as const;
const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"] as const;

function severityIndex(severity: string): number {
  return SEVERITY_ORDER.indexOf(severity as typeof SEVERITY_ORDER[number]);
}

function hasEligibleQcAutoFixProvider(providers: unknown): boolean {
  if (!isPlainObject(providers)) return false;
  return Object.values(providers).some((providerConfig) => {
    if (!isPlainObject(providerConfig)) return false;
    const capabilities = providerConfig.capabilities;
    const eligible = providerConfig.autoFixEligible;
    return eligible === true && Array.isArray(capabilities) && capabilities.includes("auto-fix");
  });
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

  // graph
  if ("graph" in config && config.graph !== undefined) {
    if (!isPlainObject(config.graph)) {
      result.valid = false;
      result.errors.push("graph must be an object");
    } else {
      if ("outputPath" in config.graph && config.graph.outputPath !== undefined) {
        if (!isString(config.graph.outputPath)) {
          result.valid = false;
          result.errors.push("graph.outputPath must be a string");
        }
      }
      if (
        "invalidationTriggers" in config.graph &&
        config.graph.invalidationTriggers !== undefined
      ) {
        if (
          !Array.isArray(config.graph.invalidationTriggers) ||
          !config.graph.invalidationTriggers.every(
            (trigger) =>
              isString(trigger) &&
              SUPPORTED_GRAPH_INVALIDATION_TRIGGERS.includes(
                trigger as typeof SUPPORTED_GRAPH_INVALIDATION_TRIGGERS[number],
              ),
          )
        ) {
          result.valid = false;
          result.errors.push(
            'graph.invalidationTriggers must contain only "repo-change" or "config-change"',
          );
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
          !SUPPORTED_EXECUTION_ADAPTERS.includes(config.execution.adapter as typeof SUPPORTED_EXECUTION_ADAPTERS[number])
        ) {
          result.valid = false;
          result.errors.push("execution.adapter must be one of agent-subtask, terminal-cli, ci, ssh, remote-worker, cross-agent");
        }
      }
      if ("providers" in config.execution && config.execution.providers !== undefined) {
        if (!isPlainObject(config.execution.providers)) {
          result.valid = false;
          result.errors.push("execution.providers must be a plain object");
        }
      }
      if ("rotation" in config.execution && config.execution.rotation !== undefined) {
        if (!isStringArray(config.execution.rotation)) {
          result.valid = false;
          result.errors.push("execution.rotation must be an array of strings");
        }
      }
      if ("allowCrossAgentFallback" in config.execution && config.execution.allowCrossAgentFallback !== undefined) {
        if (!isBoolean(config.execution.allowCrossAgentFallback)) {
          result.valid = false;
          result.errors.push("execution.allowCrossAgentFallback must be a boolean");
        }
      }
      if ("roles" in config.execution && config.execution.roles !== undefined) {
        if (!isPlainObject(config.execution.roles)) {
          result.valid = false;
          result.errors.push("execution.roles must be a plain object");
        } else {
          for (const [roleName, roleConfig] of Object.entries(config.execution.roles)) {
            if (!SUPPORTED_EXECUTION_ROLES.includes(roleName as typeof SUPPORTED_EXECUTION_ROLES[number])) {
              result.valid = false;
              result.errors.push(`execution.roles contains unsupported role: ${roleName}`);
              continue;
            }
            if (!isPlainObject(roleConfig)) {
              result.valid = false;
              result.errors.push(`execution.roles.${roleName} must be a plain object`);
              continue;
            }
            if ("adapter" in roleConfig && roleConfig.adapter !== undefined) {
              if (!isString(roleConfig.adapter) || !SUPPORTED_EXECUTION_ADAPTERS.includes(roleConfig.adapter as typeof SUPPORTED_EXECUTION_ADAPTERS[number])) {
                result.valid = false;
                result.errors.push(`execution.roles.${roleName}.adapter must be one of agent-subtask, terminal-cli, ci, ssh, remote-worker, cross-agent`);
              }
            }
            if ("provider" in roleConfig && roleConfig.provider !== undefined && !isString(roleConfig.provider)) {
              result.valid = false;
              result.errors.push(`execution.roles.${roleName}.provider must be a string`);
            }
            if ("model" in roleConfig && roleConfig.model !== undefined && !isString(roleConfig.model)) {
              result.valid = false;
              result.errors.push(`execution.roles.${roleName}.model must be a string`);
            }
            if ("command" in roleConfig && roleConfig.command !== undefined && !isString(roleConfig.command)) {
              result.valid = false;
              result.errors.push(`execution.roles.${roleName}.command must be a string`);
            }
            if ("args" in roleConfig && roleConfig.args !== undefined && !isStringArray(roleConfig.args)) {
              result.valid = false;
              result.errors.push(`execution.roles.${roleName}.args must be an array of strings`);
            }
          }
        }
      }
      if ("providerPolicy" in config.execution && config.execution.providerPolicy !== undefined) {
        if (!isPlainObject(config.execution.providerPolicy)) {
          result.valid = false;
          result.errors.push("execution.providerPolicy must be a plain object");
        } else {
          const providerKeys = isPlainObject(config.execution.providers)
            ? new Set(Object.keys(config.execution.providers))
            : null;
          for (const [roleName, rolePolicy] of Object.entries(config.execution.providerPolicy)) {
            if (!SUPPORTED_EXECUTION_ROLES.includes(roleName as typeof SUPPORTED_EXECUTION_ROLES[number])) {
              result.valid = false;
              result.errors.push(`execution.providerPolicy contains unsupported role: ${roleName}`);
              continue;
            }
            if (!isPlainObject(rolePolicy)) {
              result.valid = false;
              result.errors.push(`execution.providerPolicy.${roleName} must be a plain object`);
              continue;
            }
            if (!("providers" in rolePolicy) || !isStringArray(rolePolicy.providers)) {
              result.valid = false;
              result.errors.push(`execution.providerPolicy.${roleName}.providers must be an array of strings`);
            } else if (providerKeys) {
              for (const providerName of rolePolicy.providers) {
                if (!providerKeys.has(providerName)) {
                  result.valid = false;
                  result.errors.push(`execution.providerPolicy.${roleName}.providers contains unknown provider: ${providerName}`);
                }
              }
            }
            if ("allowNativeSubagent" in rolePolicy && rolePolicy.allowNativeSubagent !== undefined && !isBoolean(rolePolicy.allowNativeSubagent)) {
              result.valid = false;
              result.errors.push(`execution.providerPolicy.${roleName}.allowNativeSubagent must be a boolean`);
            }
            if ("noFallback" in rolePolicy && rolePolicy.noFallback !== undefined && !isBoolean(rolePolicy.noFallback)) {
              result.valid = false;
              result.errors.push(`execution.providerPolicy.${roleName}.noFallback must be a boolean`);
            }
          }
        }
      }
      if ("routerPolicy" in config.execution && config.execution.routerPolicy !== undefined) {
        if (!isPlainObject(config.execution.routerPolicy)) {
          result.valid = false;
          result.errors.push("execution.routerPolicy must be a plain object");
        } else {
          const routerPolicy = config.execution.routerPolicy;
          const providerKeys = isPlainObject(config.execution.providers)
            ? new Set(Object.keys(config.execution.providers))
            : null;
          if (
            "allowCrossProviderFallback" in routerPolicy &&
            routerPolicy.allowCrossProviderFallback !== undefined &&
            !isBoolean(routerPolicy.allowCrossProviderFallback)
          ) {
            result.valid = false;
            result.errors.push("execution.routerPolicy.allowCrossProviderFallback must be a boolean");
          }
          if (
            isBoolean(config.execution.allowCrossAgentFallback) &&
            isBoolean(routerPolicy.allowCrossProviderFallback) &&
            config.execution.allowCrossAgentFallback !== routerPolicy.allowCrossProviderFallback
          ) {
            result.valid = false;
            result.errors.push(
              "execution fallback policy is ambiguous: allowCrossAgentFallback conflicts with execution.routerPolicy.allowCrossProviderFallback",
            );
          }
          if ("defaultWorkerPool" in routerPolicy && routerPolicy.defaultWorkerPool !== undefined) {
            if (!isPlainObject(routerPolicy.defaultWorkerPool)) {
              result.valid = false;
              result.errors.push("execution.routerPolicy.defaultWorkerPool must be a plain object");
            } else {
              if (
                "maxActiveWorkers" in routerPolicy.defaultWorkerPool &&
                routerPolicy.defaultWorkerPool.maxActiveWorkers !== undefined &&
                !isPositiveInteger(routerPolicy.defaultWorkerPool.maxActiveWorkers)
              ) {
                result.valid = false;
                result.errors.push(
                  "execution.routerPolicy.defaultWorkerPool.maxActiveWorkers must be a positive integer",
                );
              }
              if (
                "maxActiveSlots" in routerPolicy.defaultWorkerPool &&
                routerPolicy.defaultWorkerPool.maxActiveSlots !== undefined &&
                !isPositiveInteger(routerPolicy.defaultWorkerPool.maxActiveSlots)
              ) {
                result.valid = false;
                result.errors.push(
                  "execution.routerPolicy.defaultWorkerPool.maxActiveSlots must be a positive integer",
                );
              }
            }
          }
          if ("providerRegistry" in routerPolicy && routerPolicy.providerRegistry !== undefined) {
            if (!isPlainObject(routerPolicy.providerRegistry)) {
              result.valid = false;
              result.errors.push("execution.routerPolicy.providerRegistry must be a plain object");
            } else {
              for (const [providerName, providerPolicy] of Object.entries(routerPolicy.providerRegistry)) {
                if (providerKeys && !providerKeys.has(providerName)) {
                  result.valid = false;
                  result.errors.push(
                    `execution.routerPolicy.providerRegistry contains unknown provider: ${providerName}`,
                  );
                }
                if (!isPlainObject(providerPolicy)) {
                  result.valid = false;
                  result.errors.push(
                    `execution.routerPolicy.providerRegistry.${providerName} must be a plain object`,
                  );
                  continue;
                }
                if ("eligibleRoles" in providerPolicy && providerPolicy.eligibleRoles !== undefined) {
                  if (
                    !Array.isArray(providerPolicy.eligibleRoles) ||
                    !providerPolicy.eligibleRoles.every(
                      (role) =>
                        isString(role) &&
                        SUPPORTED_EXECUTION_ROLES.includes(
                          role as typeof SUPPORTED_EXECUTION_ROLES[number],
                        ),
                    )
                  ) {
                    result.valid = false;
                    result.errors.push(
                      `execution.routerPolicy.providerRegistry.${providerName}.eligibleRoles must contain only supported execution roles`,
                    );
                  }
                }
                if ("capabilities" in providerPolicy && providerPolicy.capabilities !== undefined) {
                  if (
                    !Array.isArray(providerPolicy.capabilities) ||
                    !providerPolicy.capabilities.every(
                      (capability) =>
                        isString(capability) &&
                        SUPPORTED_ROUTER_CAPABILITIES.includes(
                          capability as typeof SUPPORTED_ROUTER_CAPABILITIES[number],
                        ),
                    )
                  ) {
                    result.valid = false;
                    result.errors.push(
                      `execution.routerPolicy.providerRegistry.${providerName}.capabilities must contain only: orchestration, analysis, implementation, repair, docs, finalization`,
                    );
                  }
                }
                if ("taskTypes" in providerPolicy && providerPolicy.taskTypes !== undefined) {
                  if (
                    !Array.isArray(providerPolicy.taskTypes) ||
                    !providerPolicy.taskTypes.every(
                      (taskType) =>
                        isString(taskType) &&
                        SUPPORTED_ROUTER_TASK_TYPES.includes(
                          taskType as typeof SUPPORTED_ROUTER_TASK_TYPES[number],
                        ),
                    )
                  ) {
                    result.valid = false;
                    result.errors.push(
                      `execution.routerPolicy.providerRegistry.${providerName}.taskTypes must contain only: startup, analyze, impl, repair, docs, finalize`,
                    );
                  }
                }
                if ("trustTier" in providerPolicy && providerPolicy.trustTier !== undefined) {
                  if (
                    !isString(providerPolicy.trustTier) ||
                    !SUPPORTED_ROUTER_TRUST_TIERS.includes(
                      providerPolicy.trustTier as typeof SUPPORTED_ROUTER_TRUST_TIERS[number],
                    )
                  ) {
                    result.valid = false;
                    result.errors.push(
                      `execution.routerPolicy.providerRegistry.${providerName}.trustTier must be one of: sandbox, standard, trusted`,
                    );
                  }
                }
                if ("costTier" in providerPolicy && providerPolicy.costTier !== undefined) {
                  if (
                    !isString(providerPolicy.costTier) ||
                    !SUPPORTED_ROUTER_COST_TIERS.includes(
                      providerPolicy.costTier as typeof SUPPORTED_ROUTER_COST_TIERS[number],
                    )
                  ) {
                    result.valid = false;
                    result.errors.push(
                      `execution.routerPolicy.providerRegistry.${providerName}.costTier must be one of: low, medium, high`,
                    );
                  }
                }
                if ("quotaPolicy" in providerPolicy && providerPolicy.quotaPolicy !== undefined) {
                  if (
                    !isString(providerPolicy.quotaPolicy) ||
                    !SUPPORTED_ROUTER_QUOTA_POLICIES.includes(
                      providerPolicy.quotaPolicy as typeof SUPPORTED_ROUTER_QUOTA_POLICIES[number],
                    )
                  ) {
                    result.valid = false;
                    result.errors.push(
                      `execution.routerPolicy.providerRegistry.${providerName}.quotaPolicy must be one of: best-effort, rate-limited, reserved`,
                    );
                  }
                }
                if (
                  "fallbackEligible" in providerPolicy &&
                  providerPolicy.fallbackEligible !== undefined &&
                  !isBoolean(providerPolicy.fallbackEligible)
                ) {
                  result.valid = false;
                  result.errors.push(
                    `execution.routerPolicy.providerRegistry.${providerName}.fallbackEligible must be a boolean`,
                  );
                }
                if (
                  "maxActiveSlots" in providerPolicy &&
                  providerPolicy.maxActiveSlots !== undefined &&
                  !isPositiveInteger(providerPolicy.maxActiveSlots)
                ) {
                  result.valid = false;
                  result.errors.push(
                    `execution.routerPolicy.providerRegistry.${providerName}.maxActiveSlots must be a positive integer`,
                  );
                }
              }
            }
          }
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
      if ("adapter" in config.tracker && config.tracker.adapter !== undefined) {
        if (!isString(config.tracker.adapter) || !["linear", "mcp-bridge", "local"].includes(config.tracker.adapter)) {
          result.valid = false;
          result.errors.push('tracker.adapter must be one of "linear", "mcp-bridge", or "local"');
        }
      }
      if ("lifecyclePolicy" in config.tracker && config.tracker.lifecyclePolicy !== undefined) {
        if (!isPlainObject(config.tracker.lifecyclePolicy)) {
          result.valid = false;
          result.errors.push("tracker.lifecyclePolicy must be an object");
        } else {
          const lifecyclePolicy = config.tracker.lifecyclePolicy;
          if ("childOnDispatch" in lifecyclePolicy && lifecyclePolicy.childOnDispatch !== undefined) {
            if (!isString(lifecyclePolicy.childOnDispatch) || !SUPPORTED_LIFECYCLE_STATES.includes(lifecyclePolicy.childOnDispatch as typeof SUPPORTED_LIFECYCLE_STATES[number])) {
              result.valid = false;
              result.errors.push('tracker.lifecyclePolicy.childOnDispatch must be one of: backlog, in_progress, in_review, done, blocked, cancelled, no_status_change');
            }
          }
          if ("childOnValidationPassed" in lifecyclePolicy && lifecyclePolicy.childOnValidationPassed !== undefined) {
            if (!isString(lifecyclePolicy.childOnValidationPassed) || !SUPPORTED_LIFECYCLE_STATES.includes(lifecyclePolicy.childOnValidationPassed as typeof SUPPORTED_LIFECYCLE_STATES[number])) {
              result.valid = false;
              result.errors.push('tracker.lifecyclePolicy.childOnValidationPassed must be one of: backlog, in_progress, in_review, done, blocked, cancelled, no_status_change');
            }
          }
          if ("childOnMerged" in lifecyclePolicy && lifecyclePolicy.childOnMerged !== undefined) {
            if (!isString(lifecyclePolicy.childOnMerged) || !SUPPORTED_LIFECYCLE_STATES.includes(lifecyclePolicy.childOnMerged as typeof SUPPORTED_LIFECYCLE_STATES[number])) {
              result.valid = false;
              result.errors.push('tracker.lifecyclePolicy.childOnMerged must be one of: backlog, in_progress, in_review, done, blocked, cancelled, no_status_change');
            }
          }
          if ("parentOnAllChildrenComplete" in lifecyclePolicy && lifecyclePolicy.parentOnAllChildrenComplete !== undefined) {
            if (!isString(lifecyclePolicy.parentOnAllChildrenComplete) || !SUPPORTED_LIFECYCLE_STATES.includes(lifecyclePolicy.parentOnAllChildrenComplete as typeof SUPPORTED_LIFECYCLE_STATES[number])) {
              result.valid = false;
              result.errors.push('tracker.lifecyclePolicy.parentOnAllChildrenComplete must be one of: backlog, in_progress, in_review, done, blocked, cancelled, no_status_change');
            }
          }
          if ("parentOnDeliveryMerged" in lifecyclePolicy && lifecyclePolicy.parentOnDeliveryMerged !== undefined) {
            if (!isString(lifecyclePolicy.parentOnDeliveryMerged) || !SUPPORTED_LIFECYCLE_STATES.includes(lifecyclePolicy.parentOnDeliveryMerged as typeof SUPPORTED_LIFECYCLE_STATES[number])) {
              result.valid = false;
              result.errors.push('tracker.lifecyclePolicy.parentOnDeliveryMerged must be one of: backlog, in_progress, in_review, done, blocked, cancelled, no_status_change');
            }
          }
          if ("childOnTriageRequired" in lifecyclePolicy && lifecyclePolicy.childOnTriageRequired !== undefined) {
            if (!isString(lifecyclePolicy.childOnTriageRequired) || !SUPPORTED_LIFECYCLE_STATES.includes(lifecyclePolicy.childOnTriageRequired as typeof SUPPORTED_LIFECYCLE_STATES[number])) {
              result.valid = false;
              result.errors.push('tracker.lifecyclePolicy.childOnTriageRequired must be one of: backlog, in_progress, in_review, done, blocked, cancelled, no_status_change');
            }
          }
          if ("providerFailureBeforeWork" in lifecyclePolicy && lifecyclePolicy.providerFailureBeforeWork !== undefined) {
            if (!isString(lifecyclePolicy.providerFailureBeforeWork) || !SUPPORTED_LIFECYCLE_STATES.includes(lifecyclePolicy.providerFailureBeforeWork as typeof SUPPORTED_LIFECYCLE_STATES[number])) {
              result.valid = false;
              result.errors.push('tracker.lifecyclePolicy.providerFailureBeforeWork must be one of: backlog, in_progress, in_review, done, blocked, cancelled, no_status_change');
            }
          }
        }
      }
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
      if ("mcpBridge" in config.tracker && config.tracker.mcpBridge !== undefined) {
        if (!isPlainObject(config.tracker.mcpBridge)) {
          result.valid = false;
          result.errors.push("tracker.mcpBridge must be an object");
        } else {
          if ("enabled" in config.tracker.mcpBridge && config.tracker.mcpBridge.enabled !== undefined) {
            if (!isBoolean(config.tracker.mcpBridge.enabled)) {
              result.valid = false;
              result.errors.push("tracker.mcpBridge.enabled must be a boolean");
            }
          }
          if ("teamId" in config.tracker.mcpBridge && config.tracker.mcpBridge.teamId !== undefined) {
            if (!isString(config.tracker.mcpBridge.teamId)) {
              result.valid = false;
              result.errors.push("tracker.mcpBridge.teamId must be a string");
            }
          }
          if ("projectId" in config.tracker.mcpBridge && config.tracker.mcpBridge.projectId !== undefined) {
            if (!isString(config.tracker.mcpBridge.projectId)) {
              result.valid = false;
              result.errors.push("tracker.mcpBridge.projectId must be a string");
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

  // providers
  if ("providers" in config && config.providers !== undefined) {
    if (!isPlainObject(config.providers)) {
      result.valid = false;
      result.errors.push("providers must be an object");
    } else {
      if ("repoAnalysis" in config.providers && config.providers.repoAnalysis !== undefined) {
        if (!isPlainObject(config.providers.repoAnalysis)) {
          result.valid = false;
          result.errors.push("providers.repoAnalysis must be an object");
        } else {
          if (
            "preferred" in config.providers.repoAnalysis &&
            config.providers.repoAnalysis.preferred !== undefined
          ) {
            if (!isString(config.providers.repoAnalysis.preferred)) {
              result.valid = false;
              result.errors.push("providers.repoAnalysis.preferred must be a string");
            }
          }
          if (
            "fallback" in config.providers.repoAnalysis &&
            config.providers.repoAnalysis.fallback !== undefined
          ) {
            if (!isStringArray(config.providers.repoAnalysis.fallback)) {
              result.valid = false;
              result.errors.push(
                "providers.repoAnalysis.fallback must be an array of strings",
              );
            }
          }
        }
      }
      if (
        "compactionProviders" in config.providers &&
        config.providers.compactionProviders !== undefined
      ) {
        if (!isStringArray(config.providers.compactionProviders)) {
          result.valid = false;
          result.errors.push(
            "providers.compactionProviders must be an array of strings",
          );
        } else {
          // Validate each provider ID is supported
          for (const providerId of config.providers.compactionProviders) {
            if (!SUPPORTED_COMPACTION_PROVIDER_IDS.includes(providerId as typeof SUPPORTED_COMPACTION_PROVIDER_IDS[number])) {
              result.valid = false;
              result.errors.push(
                `providers.compactionProviders contains unsupported provider id: ${providerId}`,
              );
            }
          }
        }
      }
    }
  }

  // canon
  if ("canon" in config && config.canon !== undefined) {
    if (!isPlainObject(config.canon)) {
      result.valid = false;
      result.errors.push("canon must be an object");
    } else {
      if ("checkOnContinue" in config.canon && config.canon.checkOnContinue !== undefined) {
        if (!isBoolean(config.canon.checkOnContinue)) {
          result.valid = false;
          result.errors.push("canon.checkOnContinue must be a boolean");
        }
      }
      if ("checkOnFinalize" in config.canon && config.canon.checkOnFinalize !== undefined) {
        if (!isBoolean(config.canon.checkOnFinalize)) {
          result.valid = false;
          result.errors.push("canon.checkOnFinalize must be a boolean");
        }
      }
    }
  }

  // budget
  if ("budget" in config && config.budget !== undefined) {
    if (!isPlainObject(config.budget)) {
      result.valid = false;
      result.errors.push("budget must be an object");
    } else {
      if ("mode" in config.budget && config.budget.mode !== undefined) {
        if (
          !isString(config.budget.mode) ||
          !["fixed-cap", "run-until-done", "stop-on-fail"].includes(config.budget.mode)
        ) {
          result.valid = false;
          result.errors.push('budget.mode must be one of "fixed-cap", "run-until-done", "stop-on-fail"');
        }
      }
      if ("max_children" in config.budget && config.budget.max_children !== undefined) {
        if (!isNumber(config.budget.max_children) || config.budget.max_children < 1 || !Number.isInteger(config.budget.max_children)) {
          result.valid = false;
          result.errors.push("budget.max_children must be a positive integer");
        }
      }
      if ("stop_on_fail" in config.budget && config.budget.stop_on_fail !== undefined) {
        if (!isBoolean(config.budget.stop_on_fail)) {
          result.valid = false;
          result.errors.push("budget.stop_on_fail must be a boolean");
        }
      }
      if ("allow_analyze_children" in config.budget && config.budget.allow_analyze_children !== undefined) {
        if (!isBoolean(config.budget.allow_analyze_children)) {
          result.valid = false;
          result.errors.push("budget.allow_analyze_children must be a boolean");
        }
      }
    }
  }

  // compact
  if ("compact" in config && config.compact !== undefined) {
    if (!isPlainObject(config.compact)) {
      result.valid = false;
      result.errors.push("compact must be an object");
    } else {
      if ("orchestratorMode" in config.compact && config.compact.orchestratorMode !== undefined) {
        if (
          !isString(config.compact.orchestratorMode) ||
          !["standard", "strict"].includes(config.compact.orchestratorMode)
        ) {
          result.valid = false;
          result.errors.push('compact.orchestratorMode must be either "standard" or "strict"');
        }
      }
      if ("workerMode" in config.compact && config.compact.workerMode !== undefined) {
        if (
          !isString(config.compact.workerMode) ||
          !["standard", "strict", "minimal"].includes(config.compact.workerMode)
        ) {
          result.valid = false;
          result.errors.push('compact.workerMode must be one of "standard", "strict", "minimal"');
        }
      }
      if ("level" in config.compact && config.compact.level !== undefined) {
        if (
          !isString(config.compact.level) ||
          !["standard", "strict", "minimal"].includes(config.compact.level)
        ) {
          result.valid = false;
          result.errors.push('compact.level must be one of "standard", "strict", "minimal"');
        }
      }
    }
  }

  // qc
  if ("qc" in config && config.qc !== undefined) {
    if (!isPlainObject(config.qc)) {
      result.valid = false;
      result.errors.push("qc must be an object");
    } else {
      if ("enabled" in config.qc && config.qc.enabled !== undefined) {
        if (!isBoolean(config.qc.enabled)) {
          result.valid = false;
          result.errors.push("qc.enabled must be a boolean");
        }
      }
      if ("defaultTrigger" in config.qc && config.qc.defaultTrigger !== undefined) {
        if (
          !isString(config.qc.defaultTrigger) ||
          !SUPPORTED_QC_TRIGGERS.includes(config.qc.defaultTrigger as typeof SUPPORTED_QC_TRIGGERS[number])
        ) {
          result.valid = false;
          result.errors.push('qc.defaultTrigger must be one of "pr", "completed-cluster", "child"');
        }
      }

      const providers = isPlainObject(config.qc.providers) ? config.qc.providers : null;
      if ("providers" in config.qc && config.qc.providers !== undefined) {
        if (!isPlainObject(config.qc.providers)) {
          result.valid = false;
          result.errors.push("qc.providers must be a plain object");
        } else {
          for (const [providerName, providerConfig] of Object.entries(config.qc.providers)) {
            if (!isPlainObject(providerConfig)) {
              result.valid = false;
              result.errors.push(`qc.providers.${providerName} must be a plain object`);
              continue;
            }
            if ("name" in providerConfig && providerConfig.name !== undefined && !isString(providerConfig.name)) {
              result.valid = false;
              result.errors.push(`qc.providers.${providerName}.name must be a string`);
            }
            if ("mode" in providerConfig && providerConfig.mode !== undefined) {
              if (
                !isString(providerConfig.mode) ||
                !SUPPORTED_QC_PROVIDER_MODES.includes(providerConfig.mode as typeof SUPPORTED_QC_PROVIDER_MODES[number])
              ) {
                result.valid = false;
                result.errors.push(
                  `qc.providers.${providerName}.mode must be one of local, pr, metrics-import`,
                );
              }
            } else {
              result.valid = false;
              result.errors.push(`qc.providers.${providerName}.mode is required`);
            }
            if ("capabilities" in providerConfig && providerConfig.capabilities !== undefined) {
              if (
                !Array.isArray(providerConfig.capabilities) ||
                !providerConfig.capabilities.every(
                  (capability) =>
                    isString(capability) &&
                    SUPPORTED_QC_PROVIDER_CAPABILITIES.includes(
                      capability as typeof SUPPORTED_QC_PROVIDER_CAPABILITIES[number],
                    ),
                )
              ) {
                result.valid = false;
                result.errors.push(
                  `qc.providers.${providerName}.capabilities must contain only: diff-review, pr-review, result-parsing, auto-fix, metrics-import`,
                );
              }
            }
            if ("trigger" in providerConfig && providerConfig.trigger !== undefined) {
              if (
                !isString(providerConfig.trigger) ||
                !SUPPORTED_QC_TRIGGERS.includes(providerConfig.trigger as typeof SUPPORTED_QC_TRIGGERS[number])
              ) {
                result.valid = false;
                result.errors.push(
                  `qc.providers.${providerName}.trigger must be one of pr, completed-cluster, child`,
                );
              }
            }
            if ("autoFixEligible" in providerConfig && providerConfig.autoFixEligible !== undefined) {
              if (!isBoolean(providerConfig.autoFixEligible)) {
                result.valid = false;
                result.errors.push(`qc.providers.${providerName}.autoFixEligible must be a boolean`);
              }
            }
            if ("severityMapping" in providerConfig && providerConfig.severityMapping !== undefined) {
              if (!isPlainObject(providerConfig.severityMapping)) {
                result.valid = false;
                result.errors.push(`qc.providers.${providerName}.severityMapping must be a plain object`);
              } else {
                for (const [label, severity] of Object.entries(providerConfig.severityMapping)) {
                  if (
                    !isString(severity) ||
                    !SUPPORTED_QC_SEVERITIES.includes(severity as typeof SUPPORTED_QC_SEVERITIES[number])
                  ) {
                    result.valid = false;
                    result.errors.push(
                      `qc.providers.${providerName}.severityMapping.${label} must be one of critical, high, medium, low, info`,
                    );
                  }
                }
              }
            }
            if ("enabled" in providerConfig && providerConfig.enabled !== undefined && !isBoolean(providerConfig.enabled)) {
              result.valid = false;
              result.errors.push(`qc.providers.${providerName}.enabled must be a boolean`);
            }
            if ("execution" in providerConfig && providerConfig.execution !== undefined) {
              if (!isPlainObject(providerConfig.execution)) {
                result.valid = false;
                result.errors.push(`qc.providers.${providerName}.execution must be a plain object`);
              } else {
                const execution = providerConfig.execution;
                if ("command" in execution && execution.command !== undefined && !isString(execution.command)) {
                  result.valid = false;
                  result.errors.push(`qc.providers.${providerName}.execution.command must be a string`);
                }
                if ("args" in execution && execution.args !== undefined && !isStringArray(execution.args)) {
                  result.valid = false;
                  result.errors.push(`qc.providers.${providerName}.execution.args must be an array of strings`);
                }
                if ("output" in execution && execution.output !== undefined) {
                  if (!isPlainObject(execution.output)) {
                    result.valid = false;
                    result.errors.push(`qc.providers.${providerName}.execution.output must be a plain object`);
                  } else {
                    if (
                      "format" in execution.output &&
                      execution.output.format !== undefined &&
                      (!isString(execution.output.format) ||
                        !SUPPORTED_QC_OUTPUT_FORMATS.includes(
                          execution.output.format as typeof SUPPORTED_QC_OUTPUT_FORMATS[number],
                        ))
                    ) {
                      result.valid = false;
                      result.errors.push(
                        `qc.providers.${providerName}.execution.output.format must be one of json, jsonl, sarif, generic`,
                      );
                    }
                    if (
                      "parser" in execution.output &&
                      execution.output.parser !== undefined &&
                      !isString(execution.output.parser)
                    ) {
                      result.valid = false;
                      result.errors.push(
                        `qc.providers.${providerName}.execution.output.parser must be a string`,
                      );
                    }
                  }
                }
                if (
                  "configPath" in execution &&
                  execution.configPath !== undefined &&
                  !isString(execution.configPath)
                ) {
                  result.valid = false;
                  result.errors.push(`qc.providers.${providerName}.execution.configPath must be a string`);
                }
              }
            }
            if ("timeoutMs" in providerConfig && providerConfig.timeoutMs !== undefined && !isPositiveInteger(providerConfig.timeoutMs)) {
              result.valid = false;
              result.errors.push(`qc.providers.${providerName}.timeoutMs must be a positive integer`);
            }
            if ("primary" in providerConfig && providerConfig.primary !== undefined && !isBoolean(providerConfig.primary)) {
              result.valid = false;
              result.errors.push(`qc.providers.${providerName}.primary must be a boolean`);
            }
            if ("fallback" in providerConfig && providerConfig.fallback !== undefined && !isStringArray(providerConfig.fallback)) {
              result.valid = false;
              result.errors.push(`qc.providers.${providerName}.fallback must be an array of strings`);
            }
            if ("failurePolicy" in providerConfig && providerConfig.failurePolicy !== undefined) {
              if (!isPlainObject(providerConfig.failurePolicy)) {
                result.valid = false;
                result.errors.push(`qc.providers.${providerName}.failurePolicy must be a plain object`);
              } else {
                for (const key of ["timeout", "parseFailure", "allProvidersFailed"] as const) {
                  const value = providerConfig.failurePolicy[key];
                  if (value !== undefined && (!isString(value) || !SUPPORTED_QC_FAILURE_ACTIONS.includes(value as typeof SUPPORTED_QC_FAILURE_ACTIONS[number]))) {
                    result.valid = false;
                    result.errors.push(
                      `qc.providers.${providerName}.failurePolicy.${key} must be one of fail, fallback, ignore, block`,
                    );
                  }
                }
              }
            }
            if ("rateLimit" in providerConfig && providerConfig.rateLimit !== undefined) {
              if (!isPlainObject(providerConfig.rateLimit)) {
                result.valid = false;
                result.errors.push(`qc.providers.${providerName}.rateLimit must be a plain object`);
              } else {
                if (
                  "requestsPerMinute" in providerConfig.rateLimit &&
                  providerConfig.rateLimit.requestsPerMinute !== undefined &&
                  !isPositiveInteger(providerConfig.rateLimit.requestsPerMinute)
                ) {
                  result.valid = false;
                  result.errors.push(
                    `qc.providers.${providerName}.rateLimit.requestsPerMinute must be a positive integer`,
                  );
                }
                if (
                  "maxConcurrent" in providerConfig.rateLimit &&
                  providerConfig.rateLimit.maxConcurrent !== undefined &&
                  !isPositiveInteger(providerConfig.rateLimit.maxConcurrent)
                ) {
                  result.valid = false;
                  result.errors.push(
                    `qc.providers.${providerName}.rateLimit.maxConcurrent must be a positive integer`,
                  );
                }
              }
            }
            if ("retry" in providerConfig && providerConfig.retry !== undefined) {
              if (!isPlainObject(providerConfig.retry)) {
                result.valid = false;
                result.errors.push(`qc.providers.${providerName}.retry must be a plain object`);
              } else {
                if (
                  "maxRetries" in providerConfig.retry &&
                  providerConfig.retry.maxRetries !== undefined &&
                  !isNonNegativeInteger(providerConfig.retry.maxRetries)
                ) {
                  result.valid = false;
                  result.errors.push(
                    `qc.providers.${providerName}.retry.maxRetries must be a non-negative integer`,
                  );
                }
                if (
                  "backoffMs" in providerConfig.retry &&
                  providerConfig.retry.backoffMs !== undefined &&
                  !isNonNegativeInteger(providerConfig.retry.backoffMs)
                ) {
                  result.valid = false;
                  result.errors.push(
                    `qc.providers.${providerName}.retry.backoffMs must be a non-negative integer`,
                  );
                }
              }
            }
            if ("artifactPolicy" in providerConfig && providerConfig.artifactPolicy !== undefined) {
              if (!isPlainObject(providerConfig.artifactPolicy)) {
                result.valid = false;
                result.errors.push(`qc.providers.${providerName}.artifactPolicy must be a plain object`);
              } else {
                if (
                  "retainRawOutput" in providerConfig.artifactPolicy &&
                  providerConfig.artifactPolicy.retainRawOutput !== undefined &&
                  !isBoolean(providerConfig.artifactPolicy.retainRawOutput)
                ) {
                  result.valid = false;
                  result.errors.push(
                    `qc.providers.${providerName}.artifactPolicy.retainRawOutput must be a boolean`,
                  );
                }
                if (
                  "outputDir" in providerConfig.artifactPolicy &&
                  providerConfig.artifactPolicy.outputDir !== undefined &&
                  !isString(providerConfig.artifactPolicy.outputDir)
                ) {
                  result.valid = false;
                  result.errors.push(
                    `qc.providers.${providerName}.artifactPolicy.outputDir must be a string`,
                  );
                }
              }
            }
          }
          // Validate fallback references after all provider keys are known.
          if (providers) {
            const providerKeys = new Set(Object.keys(config.qc.providers as Record<string, unknown>));
            for (const [providerName, providerConfig] of Object.entries(config.qc.providers as Record<string, unknown>)) {
              if (!isPlainObject(providerConfig)) continue;
              const fallback = providerConfig.fallback;
              if (Array.isArray(fallback)) {
                for (const fallbackName of fallback) {
                  if (isString(fallbackName) && !providerKeys.has(fallbackName)) {
                    result.valid = false;
                    result.errors.push(
                      `qc.providers.${providerName}.fallback contains unknown provider: ${fallbackName}`,
                    );
                  }
                }
              }
            }
          }
        }
      }

      if ("severityThresholds" in config.qc && config.qc.severityThresholds !== undefined) {
        if (!isPlainObject(config.qc.severityThresholds)) {
          result.valid = false;
          result.errors.push("qc.severityThresholds must be a plain object");
        } else {
          const thresholds = config.qc.severityThresholds;
          for (const key of ["block", "repair", "followUp"] as const) {
            if (key in thresholds && thresholds[key] !== undefined) {
              if (
                !isString(thresholds[key]) ||
                !SUPPORTED_QC_SEVERITIES.includes(thresholds[key] as typeof SUPPORTED_QC_SEVERITIES[number])
              ) {
                result.valid = false;
                result.errors.push(`qc.severityThresholds.${key} must be one of critical, high, medium, low, info`);
              }
            }
          }
          if (
            isString(thresholds.block) &&
            SUPPORTED_QC_SEVERITIES.includes(thresholds.block as typeof SUPPORTED_QC_SEVERITIES[number]) &&
            isString(thresholds.repair) &&
            SUPPORTED_QC_SEVERITIES.includes(thresholds.repair as typeof SUPPORTED_QC_SEVERITIES[number]) &&
            severityIndex(thresholds.block) < severityIndex(thresholds.repair)
          ) {
            result.valid = false;
            result.errors.push(
              "qc.severityThresholds.repair must be at or below qc.severityThresholds.block severity",
            );
          }
          if (
            isString(thresholds.repair) &&
            SUPPORTED_QC_SEVERITIES.includes(thresholds.repair as typeof SUPPORTED_QC_SEVERITIES[number]) &&
            isString(thresholds.followUp) &&
            SUPPORTED_QC_SEVERITIES.includes(thresholds.followUp as typeof SUPPORTED_QC_SEVERITIES[number]) &&
            severityIndex(thresholds.repair) < severityIndex(thresholds.followUp)
          ) {
            result.valid = false;
            result.errors.push(
              "qc.severityThresholds.followUp must be at or below qc.severityThresholds.repair severity",
            );
          }
        }
      }

      if ("autoFix" in config.qc && config.qc.autoFix !== undefined) {
        if (
          !isString(config.qc.autoFix) ||
          !SUPPORTED_QC_AUTO_FIX_POLICIES.includes(config.qc.autoFix as typeof SUPPORTED_QC_AUTO_FIX_POLICIES[number])
        ) {
          result.valid = false;
          result.errors.push('qc.autoFix must be one of "disabled", "dry-run", "apply"');
        }
      }

      if ("repairRouting" in config.qc && config.qc.repairRouting !== undefined) {
        if (
          !isString(config.qc.repairRouting) ||
          !SUPPORTED_QC_REPAIR_ROUTING_POLICIES.includes(
            config.qc.repairRouting as typeof SUPPORTED_QC_REPAIR_ROUTING_POLICIES[number],
          )
        ) {
          result.valid = false;
          result.errors.push('qc.repairRouting must be one of "block", "route", "follow-up", "log"');
        }
      }

      if ("artifactRetention" in config.qc && config.qc.artifactRetention !== undefined) {
        if (!isPlainObject(config.qc.artifactRetention)) {
          result.valid = false;
          result.errors.push("qc.artifactRetention must be a plain object");
        } else {
          const retention = config.qc.artifactRetention;
          if ("retainRawOutput" in retention && retention.retainRawOutput !== undefined) {
            if (!isBoolean(retention.retainRawOutput)) {
              result.valid = false;
              result.errors.push("qc.artifactRetention.retainRawOutput must be a boolean");
            }
          }
          if ("maxRuns" in retention && retention.maxRuns !== undefined) {
            if (!isPositiveInteger(retention.maxRuns)) {
              result.valid = false;
              result.errors.push("qc.artifactRetention.maxRuns must be a positive integer");
            }
          }
        }
      }

      if ("routes" in config.qc && config.qc.routes !== undefined) {
        if (!isPlainObject(config.qc.routes)) {
          result.valid = false;
          result.errors.push("qc.routes must be a plain object");
        } else {
          for (const [routeName, routePolicy] of Object.entries(config.qc.routes)) {
            if (!isPlainObject(routePolicy)) {
              result.valid = false;
              result.errors.push(`qc.routes.${routeName} must be a plain object`);
              continue;
            }
            if ("childLevel" in routePolicy && routePolicy.childLevel !== undefined) {
              if (!isBoolean(routePolicy.childLevel)) {
                result.valid = false;
                result.errors.push(`qc.routes.${routeName}.childLevel must be a boolean`);
              }
            }
            if ("blockThreshold" in routePolicy && routePolicy.blockThreshold !== undefined) {
              if (
                !isString(routePolicy.blockThreshold) ||
                !SUPPORTED_QC_SEVERITIES.includes(
                  routePolicy.blockThreshold as typeof SUPPORTED_QC_SEVERITIES[number],
                )
              ) {
                result.valid = false;
                result.errors.push(
                  `qc.routes.${routeName}.blockThreshold must be one of critical, high, medium, low, info`,
                );
              }
            }
            if ("autoFix" in routePolicy && routePolicy.autoFix !== undefined) {
              if (
                !isString(routePolicy.autoFix) ||
                !SUPPORTED_QC_AUTO_FIX_POLICIES.includes(
                  routePolicy.autoFix as typeof SUPPORTED_QC_AUTO_FIX_POLICIES[number],
                )
              ) {
                result.valid = false;
                result.errors.push(
                  `qc.routes.${routeName}.autoFix must be one of disabled, dry-run, apply`,
                );
              }
              if (routePolicy.autoFix === "apply" && !hasEligibleQcAutoFixProvider(providers)) {
                result.valid = false;
                result.errors.push(
                  `qc.routes.${routeName}.autoFix "apply" requires at least one provider with capability "auto-fix" and autoFixEligible true`,
                );
              }
            }
          }
        }
      }

      // Unsafe auto-fix policy combinations
      const autoFix = isString(config.qc.autoFix)
        ? config.qc.autoFix
        : "disabled";
      const blockSeverity = isPlainObject(config.qc.severityThresholds)
        ? config.qc.severityThresholds.block
        : undefined;

      if (autoFix === "apply") {
        if (!hasEligibleQcAutoFixProvider(providers)) {
          result.valid = false;
          result.errors.push(
            'qc.autoFix "apply" requires at least one provider with capability "auto-fix" and autoFixEligible true',
          );
        }
        if (
          isString(blockSeverity) &&
          SUPPORTED_QC_SEVERITIES.includes(blockSeverity as typeof SUPPORTED_QC_SEVERITIES[number]) &&
          severityIndex(blockSeverity) <= severityIndex("medium")
        ) {
          result.valid = false;
          result.errors.push(
            'qc.autoFix "apply" is unsafe when qc.severityThresholds.block is medium or lower',
          );
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
    "graph",
    "execution",
    "finalize",
    "tracker",
    "integrations",
    "canon",
    "providers",
    "budget",
    "compact",
    "qc",
  ]);
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) {
      result.warnings.push(`Unknown config field: "${key}"`);
    }
  }

  return result;
}
