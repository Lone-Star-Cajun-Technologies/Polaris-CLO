/**
 * Unit tests for src/loop/worker-packet.ts
 *
 * Verifies compiled packet shape, type guard, and that no skill files are
 * referenced (workers receive self-contained instructions).
 */

import { describe, expect, it } from "vitest";
import {
  compileImplPacket,
  compileStartupPacket,
  compileFinalizePacket,
  compilePreflightPacket,
  isWorkerPacket,
  IMPL_RETURN_CONTRACT,
  STARTUP_RETURN_CONTRACT,
  FINALIZE_RETURN_CONTRACT,
  PREFLIGHT_RETURN_CONTRACT,
  WORKER_PROHIBITED_WRITE_PATHS,
  type WorkerPacket,
} from "./worker-packet.js";
import { buildWorkerInstructions } from "./adapters/worker-instructions.js";
import type { BootstrapPacket } from "./adapters/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE = {
  runId: "run-001",
  clusterId: "POL-120",
  branch: "feature/pol-120",
  stateFile: "/repo/.taskchain_artifacts/polaris-run/current-state.json",
  telemetryFile: "/repo/.taskchain_artifacts/polaris-run/runs/run-001/telemetry.jsonl",
  resultFile: "/repo/.polaris/clusters/POL-120/results/POL-121-test-uuid.json",
};

// ── isWorkerPacket type guard ─────────────────────────────────────────────────

describe("isWorkerPacket", () => {
  it("returns false for a v1 BootstrapPacket", () => {
    const v1: BootstrapPacket = {
      schema_version: "1.0",
      run_id: "run-001",
      cluster_id: "POL-120",
      active_child: "POL-121",
      state_file: BASE.stateFile,
      telemetry_file: BASE.telemetryFile,
    };
    expect(isWorkerPacket(v1)).toBe(false);
  });

  it("returns true for a compiled WorkerPacket", () => {
    const packet = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(isWorkerPacket(packet)).toBe(true);
  });

  it("returns true for a compiled WorkerPacket (always has result_file_contract)", () => {
    const packet = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(isWorkerPacket(packet)).toBe(true);
    expect(packet.result_file_contract.result_file).toBe(BASE.resultFile);
  });

  it("returns false if result_file_contract is missing", () => {
    const packet = compileImplPacket({ ...BASE, childId: "POL-121" });
    const { result_file_contract: _, ...withoutContract } = packet as any;
    expect(isWorkerPacket(withoutContract as any)).toBe(false);
  });

  it("returns false if result_file_contract is malformed", () => {
    const packet = compileImplPacket({ ...BASE, childId: "POL-121" });
    (packet as any).result_file_contract = { result_file: 123 };
    expect(isWorkerPacket(packet)).toBe(false);
  });
});

// ── compileImplPacket ─────────────────────────────────────────────────────────

describe("compileImplPacket", () => {
  it("produces schema_version 2.1 and worker_role impl", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.schema_version).toBe("2.1");
    expect(p.worker_role).toBe("impl");
    expect(p.routing_context).toEqual({
      task_type: "impl",
      required_capabilities: ["implementation"],
    });
  });

  it("sets active_child to the child ID (BootstrapPacket compat)", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.active_child).toBe("POL-121");
  });

  it("includes the child ID in steps and primary_goal", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.instructions.primary_goal).toContain("POL-121");
    const stepsText = p.instructions.steps.join(" ");
    expect(stepsText).toContain("POL-121");
  });

  it("embeds pre-compiled steps so workers do not re-ingest skills", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    // Steps must not reference any skill file path
    const stepsText = p.instructions.steps.join(" ");
    expect(stepsText).not.toContain(".codex/skills");
    expect(stepsText).not.toContain("chain.md");
    // Steps must include one-child termination instruction
    expect(stepsText.toUpperCase()).toContain("TERMINATE");
  });

  it("includes issue context requirements in steps when provided", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-121",
      issueContext: {
        id: "POL-121",
        title: "Add validation layer",
        key_requirements: ["Validate schema on load", "Emit error events"],
      },
    });
    const stepsText = p.instructions.steps.join(" ");
    expect(stepsText).toContain("Validate schema on load");
    expect(stepsText).toContain("Emit error events");
  });

  it("includes the issue body in steps when body is present", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-121",
      issueContext: {
        id: "POL-121",
        title: "Add validation layer",
        key_requirements: [],
        body: "As a user I want input validation so that bad data is rejected early.",
      },
    });
    const stepsText = p.instructions.steps.join("\n");
    expect(stepsText).toContain("As a user I want input validation");
  });

  it("includes the issue body in primary_goal via the prompt when body is present", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-121",
      issueContext: {
        id: "POL-121",
        title: "Add validation layer",
        key_requirements: [],
        body: "As a user I want input validation so that bad data is rejected early.",
      },
    });
    expect(p.instructions.primary_goal).toContain("As a user I want input validation");
  });

  it("does not include a description step when body is absent", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-121",
      issueContext: {
        id: "POL-121",
        title: "Add validation layer",
        key_requirements: [],
      },
    });
    const stepsText = p.instructions.steps.join("\n");
    expect(stepsText).not.toContain("Issue description:");
  });

  it("respects allowedScope and validationCommands", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-121",
      allowedScope: ["src/loop/**"],
      validationCommands: ["npm test"],
    });
    expect(p.instructions.allowed_scope).toEqual(["src/loop/**"]);
    expect(p.instructions.validation_commands).toEqual(["npm test"]);
  });

  it("expands allowedScope with adjacent test paths when validation includes vitest", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-121",
      allowedScope: [
        "src/loop/worker-packet.ts",
        "src/finalize/index.ts",
      ],
      validationCommands: ["npx vitest run src/loop src/finalize"],
    });
    expect(p.instructions.allowed_scope).toEqual([
      "src/loop/worker-packet.ts",
      "src/finalize/index.ts",
      "src/loop/worker-packet.test.ts",
    ]);
  });

  it("does not expand test paths when validation commands omit vitest", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-121",
      allowedScope: ["src/loop/worker-packet.ts"],
      validationCommands: ["npm run build", "npm test"],
    });
    expect(p.instructions.allowed_scope).toEqual(["src/loop/worker-packet.ts"]);
  });

  it("expands allowedScope with test paths from an issue body with vitest validation", () => {
    const body = `## Scope
- src/cli/qc.ts
- src/cli/index.ts
- src/qc/repair-loop.ts
- src/finalize/index.ts
- src/qc/POLARIS.md
- .polaris/skills/polaris-run/chain.md

## Validation
- npm run build
- npm test
- npx vitest run src/qc src/finalize src/cli
`;
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-543",
      issueContext: {
        id: "POL-543",
        title: "POL-543",
        key_requirements: [],
        body,
      },
    });
    expect(p.instructions.allowed_scope).toContain("src/cli/qc.test.ts");
    expect(p.instructions.allowed_scope).toContain("src/qc/repair-loop.test.ts");
    expect(p.instructions.allowed_scope).not.toContain("src/cli/index.test.ts");
    expect(p.instructions.allowed_scope).not.toContain("src/finalize/finalize.test.ts");
    expect(p.instructions.allowed_scope).not.toContain("src/qc/POLARIS.md.test.ts");
    expect(p.instructions.allowed_scope).not.toContain(".polaris/skills/polaris-run/chain.md.test.ts");
  });

  it("includes prohibited_write_paths on compiled impl packets", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.prohibited_write_paths).toEqual(WORKER_PROHIBITED_WRITE_PATHS);
    expect(p.prohibited_write_paths).toBeDefined();
  });

  it("has terminate_after_completion: true in lifecycle", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.lifecycle.terminate_after_completion).toBe(true);
  });

  it("defaults max_concurrent to 1", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.lifecycle.max_concurrent).toBe(1);
  });

  it("uses cleanup_on_exit: commit-and-exit", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.lifecycle.cleanup_on_exit).toBe("commit-and-exit");
  });

  it("return_contract matches IMPL_RETURN_CONTRACT", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.return_contract).toEqual(IMPL_RETURN_CONTRACT);
  });

  it("always populates result_file_contract from resultFile", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.result_file_contract.result_file).toBe(BASE.resultFile);
  });

  it("uses the provided resultFile in result_file_contract", () => {
    const customResultFile = "/tmp/custom-result.json";
    const p = compileImplPacket({ ...BASE, childId: "POL-121", resultFile: customResultFile });
    expect(p.result_file_contract.result_file).toBe(customResultFile);
  });

  it("is a valid BootstrapPacket (has all required v1 fields)", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(typeof p.run_id).toBe("string");
    expect(typeof p.cluster_id).toBe("string");
    expect(typeof p.active_child).toBe("string");
    expect(typeof p.state_file).toBe("string");
    expect(typeof p.telemetry_file).toBe("string");
  });
});

// ── compileImplPacket simplicityMode ─────────────────────────────────────────

describe("compileImplPacket simplicityMode threading", () => {
  it("injects discipline section when simplicityMode is full", () => {
    const packet = compileImplPacket({ ...BASE, childId: "POL-121", simplicityMode: "full" });
    expect(packet.instructions.primary_goal).toContain("## Implementation Discipline");
  });

  it("omits discipline section when simplicityMode is off", () => {
    const packet = compileImplPacket({ ...BASE, childId: "POL-121", simplicityMode: "off" });
    expect(packet.instructions.primary_goal).not.toContain("## Implementation Discipline");
  });

  it("defaults to full (includes discipline section) when simplicityMode is omitted", () => {
    const packet = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(packet.instructions.primary_goal).toContain("## Implementation Discipline");
  });
});

// ── compileFinalizePacket ─────────────────────────────────────────────────────

describe("compileFinalizePacket", () => {
  it("produces worker_role finalize with empty active_child", () => {
    const p = compileFinalizePacket(BASE);
    expect(p.worker_role).toBe("finalize");
    expect(p.active_child).toBe("");
    expect(p.routing_context).toEqual({
      task_type: "finalize",
      required_capabilities: ["finalization"],
    });
  });

  it("includes the target branch in steps", () => {
    const p = compileFinalizePacket({ ...BASE, targetBranch: "main" });
    const stepsText = p.instructions.steps.join(" ");
    expect(stepsText).toContain("main");
  });

  it("defaults targetBranch to main", () => {
    const p = compileFinalizePacket(BASE);
    expect(p.instructions.primary_goal).toContain("main");
  });

  it("has terminate_after_completion: true", () => {
    const p = compileFinalizePacket(BASE);
    expect(p.lifecycle.terminate_after_completion).toBe(true);
  });

  it("return_contract matches FINALIZE_RETURN_CONTRACT", () => {
    const p = compileFinalizePacket(BASE);
    expect(p.return_contract).toEqual(FINALIZE_RETURN_CONTRACT);
  });

  it("always populates result_file_contract from resultFile", () => {
    const p = compileFinalizePacket(BASE);
    expect(p.result_file_contract.result_file).toBe(BASE.resultFile);
  });

  it("does not reference skill files", () => {
    const p = compileFinalizePacket(BASE);
    const stepsText = p.instructions.steps.join(" ");
    expect(stepsText).not.toContain(".codex/skills");
  });
});

// ── compileStartupPacket ──────────────────────────────────────────────────────

describe("compileStartupPacket", () => {
  it("produces worker_role startup with empty active_child", () => {
    const p = compileStartupPacket(BASE);
    expect(p.worker_role).toBe("startup");
    expect(p.active_child).toBe("");
    expect(p.routing_context).toEqual({
      task_type: "startup",
      required_capabilities: ["orchestration"],
    });
  });

  it("return_contract matches STARTUP_RETURN_CONTRACT", () => {
    const p = compileStartupPacket(BASE);
    expect(p.return_contract).toEqual(STARTUP_RETURN_CONTRACT);
  });

  it("always populates result_file_contract from resultFile", () => {
    const p = compileStartupPacket(BASE);
    expect(p.result_file_contract.result_file).toBe(BASE.resultFile);
  });
});

// ── compilePreflightPacket ────────────────────────────────────────────────────

describe("compilePreflightPacket", () => {
  it("produces worker_role preflight", () => {
    const p = compilePreflightPacket(BASE);
    expect(p.worker_role).toBe("preflight");
  });

  it("has empty active_child", () => {
    const p = compilePreflightPacket(BASE);
    expect(p.active_child).toBe("");
  });

  it("uses cleanup_on_exit: exit-immediately", () => {
    const p = compilePreflightPacket(BASE);
    expect(p.lifecycle.cleanup_on_exit).toBe("exit-immediately");
  });

  it("has empty allowed_scope (read-only check)", () => {
    const p = compilePreflightPacket(BASE);
    expect(p.instructions.allowed_scope).toEqual([]);
  });

  it("return_contract matches PREFLIGHT_RETURN_CONTRACT", () => {
    const p = compilePreflightPacket(BASE);
    expect(p.return_contract).toEqual(PREFLIGHT_RETURN_CONTRACT);
  });

  it("always populates result_file_contract from resultFile", () => {
    const p = compilePreflightPacket(BASE);
    expect(p.result_file_contract.result_file).toBe(BASE.resultFile);
  });
});

// ── Role context (POL-227) ────────────────────────────────────────────────────

describe("role_context", () => {
  it("impl packet has worker role context", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    expect(p.role_context.role).toBe("worker");
    expect(p.role_context.role_authority).toBe("implementation");
    expect(p.role_context.may_implement).toBe(true);
    expect(p.role_context.may_assign_workers).toBe(false);
    expect(Array.isArray(p.role_context.prohibited_actions)).toBe(true);
    expect(p.role_context.prohibited_actions.length).toBeGreaterThan(0);
  });

  it("startup packet has foreman role context", () => {
    const p = compileStartupPacket(BASE);
    expect(p.role_context.role).toBe("foreman");
    expect(p.role_context.may_implement).toBe(false);
    expect(p.role_context.may_assign_workers).toBe(true);
  });

  it("finalize packet has foreman role context", () => {
    const p = compileFinalizePacket(BASE);
    expect(p.role_context.role).toBe("foreman");
    expect(p.role_context.may_implement).toBe(false);
  });

  it("preflight packet has foreman role context", () => {
    const p = compilePreflightPacket(BASE);
    expect(p.role_context.role).toBe("foreman");
    expect(p.role_context.may_implement).toBe(false);
  });
});

// ── WorkerPacket as BootstrapPacket ───────────────────────────────────────────

describe("WorkerPacket structural compatibility", () => {
  it("impl packet passes as BootstrapPacket (structural subtype)", () => {
    const p: WorkerPacket = compileImplPacket({ ...BASE, childId: "POL-121" });
    // Assign to BootstrapPacket — should compile without errors
    const bp: BootstrapPacket = p;
    expect(bp.run_id).toBe("run-001");
    expect(bp.active_child).toBe("POL-121");
  });
});

// ── Scope derivation from issue body ─────────────────────────────────────────

const BODY_WITH_SCOPE = `## Goal
Fix the packet generator scope pipeline.

## Scope
- src/loop/**
- src/cli/**

## Validation
- npm test
- npm run build
`;

describe("allowed_scope derivation from issue body", () => {
  it("derives allowed_scope from ## Scope section in body", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-277",
      issueContext: {
        id: "POL-277",
        title: "FIX: Fail packet generation when scope is empty",
        key_requirements: [],
        body: BODY_WITH_SCOPE,
      },
    });
    expect(p.instructions.allowed_scope).toEqual(["src/loop/**", "src/cli/**"]);
  });

  it("allowed_scope from body appears in the generated packet", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-277",
      issueContext: {
        id: "POL-277",
        title: "FIX",
        key_requirements: [],
        body: BODY_WITH_SCOPE,
      },
    });
    // The packet's allowed_scope and primary_goal must both reflect the body scope
    expect(p.instructions.allowed_scope.length).toBeGreaterThan(0);
    expect(p.instructions.primary_goal).toContain("src/loop");
  });

  it("explicit allowedScope overrides body-derived scope", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-277",
      allowedScope: ["src/finalize/**"],
      issueContext: {
        id: "POL-277",
        title: "FIX",
        key_requirements: [],
        body: BODY_WITH_SCOPE,
      },
    });
    expect(p.instructions.allowed_scope).toEqual(["src/finalize/**"]);
  });

  it("derives validation_commands from ## Validation section in body", () => {
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-277",
      issueContext: {
        id: "POL-277",
        title: "FIX",
        key_requirements: [],
        body: BODY_WITH_SCOPE,
      },
    });
    expect(p.instructions.validation_commands).toContain("npm test");
    expect(p.instructions.validation_commands).toContain("npm run build");
  });

  it("allowed_scope remains empty when body has no scope section (no body parser magic)", () => {
    // Empty allowed_scope is valid at compile time — gate fires at dispatch level
    const p = compileImplPacket({
      ...BASE,
      childId: "POL-277",
      issueContext: {
        id: "POL-277",
        title: "FIX",
        key_requirements: [],
        body: "## Goal\nFix something.\n",
      },
    });
    expect(p.instructions.allowed_scope).toEqual([]);
  });
});

// ── result_file_contract prompt consistency ───────────────────────────────────
// Verify the sealed result file path is identical in the JSON contract and the
// rendered worker prompt — ensuring no ad-hoc rendering diverges from the packet.

describe("result_file_contract — prompt consistency", () => {
  it("worker prompt includes the exact result file path from result_file_contract", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    const prompt = buildWorkerInstructions(p);
    expect(prompt).toContain(`SEALED RESULT FILE: ${p.result_file_contract.result_file}`);
    expect(p.result_file_contract.result_file).toBe(BASE.resultFile);
  });

  it("every packet type includes SEALED RESULT FILE in its rendered prompt", () => {
    const implPacket = compileImplPacket({ ...BASE, childId: "POL-121" });
    const startupPacket = compileStartupPacket(BASE);
    const finalizePacket = compileFinalizePacket(BASE);
    const preflightPacket = compilePreflightPacket(BASE);

    for (const packet of [implPacket, startupPacket, finalizePacket, preflightPacket]) {
      const prompt = buildWorkerInstructions(packet);
      expect(prompt).toContain("SEALED RESULT FILE:");
      expect(prompt).toContain(BASE.resultFile);
    }
  });

  it("isWorkerPacket rejects packets without result_file_contract", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    const withoutRfc = { ...p } as Partial<WorkerPacket>;
    delete withoutRfc.result_file_contract;
    expect(isWorkerPacket(withoutRfc as BootstrapPacket)).toBe(false);
  });

  it("result_file_contract serializes to JSON top-level (no undefined drop)", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    const serialized = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    const rfc = serialized.result_file_contract as Record<string, unknown>;
    expect(rfc).toBeDefined();
    expect(rfc.result_file).toBe(BASE.resultFile);
    expect(rfc.result_required_fields).toBeDefined();
  });
});

// ── SealedWorkerResult — status: done ────────────────────────────────────────

import type { SealedWorkerResult, SealedResultFileContract } from "./worker-packet.js";

describe("SealedWorkerResult", () => {
  it("accepts status: done", () => {
    const result: SealedWorkerResult = {
      run_id: "run-1",
      child_id: "POL-314",
      status: "done",
      commit: "abc1234",
      validation: "passed",
    };
    expect(result.status).toBe("done");
  });
});

describe("SealedResultFileContract", () => {
  it("includes result_required_fields template", () => {
    const contract: SealedResultFileContract = {
      result_file: ".polaris/clusters/POL-313/results/POL-314-abc.json",
      result_required_fields: {
        run_id: "<run_id from packet>",
        cluster_id: "<cluster_id from packet>",
        child_id: "<active_child from packet>",
        status: "done",
        commit: "<git commit sha>",
        validation: "passed",
      },
    };
    expect(contract.result_required_fields).toBeDefined();
    expect(contract.result_required_fields!["status"]).toBe("done");
  });
});

// ── Worker symptom categories ─────────────────────────────────────────────────

import { WORKER_SYMPTOM_CATEGORIES, type WorkerSymptomCategory } from "./worker-packet.js";
import type { WorkerRunHealthSymptom } from "../types/result-packet.js";

describe("WORKER_SYMPTOM_CATEGORIES", () => {
  it("contains the five canonical categories", () => {
    expect(WORKER_SYMPTOM_CATEGORIES).toContain("worker-blocked");
    expect(WORKER_SYMPTOM_CATEGORIES).toContain("validation-failed");
    expect(WORKER_SYMPTOM_CATEGORIES).toContain("repeated-rework");
    expect(WORKER_SYMPTOM_CATEGORIES).toContain("unclear-requirements");
    expect(WORKER_SYMPTOM_CATEGORIES).toContain("unusual-assumption");
    expect(WORKER_SYMPTOM_CATEGORIES).toHaveLength(5);
  });

  it("is referenced in compileImplPacket steps", () => {
    const p = compileImplPacket({ ...BASE, childId: "POL-121" });
    const stepsText = p.instructions.steps.join(" ");
    expect(stepsText).toContain("worker-blocked");
    expect(stepsText).toContain("validation-failed");
    expect(stepsText).toContain("run_health_symptoms");
  });
});

describe("SealedWorkerResult with run_health_symptoms", () => {
  it("accepts worker-blocked symptom in sealed result", () => {
    const result: SealedWorkerResult = {
      run_id: "run-1",
      child_id: "POL-314",
      status: "done",
      commit: "abc1234",
      run_health_symptoms: [
        {
          category: "worker-blocked",
          message: "Missing API key to complete the task",
          occurred_at: "2026-07-09T15:00:00.000Z",
        },
      ],
    };
    expect(result.run_health_symptoms).toHaveLength(1);
    expect(result.run_health_symptoms![0].category).toBe("worker-blocked");
  });

  it("accepts validation-failed symptom in sealed result", () => {
    const result: SealedWorkerResult = {
      run_id: "run-1",
      child_id: "POL-314",
      status: "done",
      commit: "abc1234",
      run_health_symptoms: [
        {
          category: "validation-failed",
          message: "npm test exited with code 1 after 3 retries",
          evidence_refs: ["logs/test-run-3.txt"],
          occurred_at: "2026-07-09T15:00:00.000Z",
        },
      ],
    };
    expect(result.run_health_symptoms![0].category).toBe("validation-failed");
    expect(result.run_health_symptoms![0].evidence_refs).toContain("logs/test-run-3.txt");
  });

  it("accepts repeated-rework symptom in sealed result", () => {
    const result: SealedWorkerResult = {
      run_id: "run-1",
      child_id: "POL-314",
      status: "done",
      commit: "abc1234",
      run_health_symptoms: [
        {
          category: "repeated-rework",
          message: "Attempted the same type narrowing fix 3 times without test progression",
          occurred_at: "2026-07-09T15:05:00.000Z",
        },
      ],
    };
    expect(result.run_health_symptoms![0].category).toBe("repeated-rework");
  });

  it("accepts unclear-requirements symptom in sealed result", () => {
    const result: SealedWorkerResult = {
      run_id: "run-1",
      child_id: "POL-314",
      status: "done",
      commit: "abc1234",
      run_health_symptoms: [
        {
          category: "unclear-requirements",
          message: "AC says both append-only and idempotent overwrite, which are contradictory",
          occurred_at: "2026-07-09T15:10:00.000Z",
        },
      ],
    };
    expect(result.run_health_symptoms![0].category).toBe("unclear-requirements");
  });

  it("accepts unusual-assumption symptom in sealed result", () => {
    const result: SealedWorkerResult = {
      run_id: "run-1",
      child_id: "POL-314",
      status: "done",
      commit: "abc1234",
      run_health_symptoms: [
        {
          category: "unusual-assumption",
          message: "Assumed zod was available because it was used in adjacent files; not in package.json",
          occurred_at: "2026-07-09T15:12:00.000Z",
        },
      ],
    };
    expect(result.run_health_symptoms![0].category).toBe("unusual-assumption");
  });

  it("allows omitting run_health_symptoms when no symptoms occurred", () => {
    const result: SealedWorkerResult = {
      run_id: "run-1",
      child_id: "POL-314",
      status: "done",
      commit: "abc1234",
    };
    expect(result.run_health_symptoms).toBeUndefined();
  });

  it("allows multiple symptoms from a single worker", () => {
    const symptoms: WorkerRunHealthSymptom[] = [
      { category: "validation-failed", message: "Build failed", occurred_at: "2026-07-09T15:00:00.000Z" },
      { category: "repeated-rework", message: "Fixed same import 4 times", occurred_at: "2026-07-09T15:01:00.000Z" },
    ];
    const result: SealedWorkerResult = {
      run_id: "run-1", child_id: "POL-314", status: "done", commit: "abc1234",
      run_health_symptoms: symptoms,
    };
    expect(result.run_health_symptoms).toHaveLength(2);
  });
});
