import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import {
  compileAndWriteRepairPackets,
  compileRepairPackets,
  getRepairPacketManifestPath,
  readRepairPacketManifest,
  writeRepairPacketManifest,
} from "./repair-packets.js";
import type { QcFinding, QcResult } from "./types.js";
import { validateRepairPacketManifest } from "./schemas.js";
import {
  DEFAULT_TEST_CONFIG,
  makeCrossFileSubsystemFindings,
  makeHighRiskFindings,
  makeLowConfidenceBroadFindings,
  makeOverlappingScopeFindings,
  makeResult,
  makeSameFileFindings,
} from "./fixtures/repair-packets.js";

describe("QC repair packet compiler", () => {
  const clusterId = "POL-TEST";
  const round = 1;
  const compiledAt = "2026-07-08T12:00:00.000Z";

  it("groups findings in the same file", () => {
    const findings = makeSameFileFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-same", findings });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const filePacket = output.packets.find((p) => p.allowedScope.includes("src/auth/login.ts"));
    expect(filePacket).toBeDefined();
    expect(filePacket!.findingIds.sort()).toEqual(
      findings.map((f) => f.findingId).sort(),
    );
  });

  it("groups cross-file findings in the same subsystem and category", () => {
    const findings = makeCrossFileSubsystemFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-sub", findings });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const subsystemPacket = output.packets.find((p) =>
      p.rootCauseHint.includes("error-handling"),
    );
    expect(subsystemPacket).toBeDefined();
    expect(subsystemPacket!.findingIds.sort()).toEqual(["f-sub-a", "f-sub-b"]);
    expect(subsystemPacket!.allowedScope).toContain("src/qc/compiler.ts");
    expect(subsystemPacket!.allowedScope).toContain("src/qc/runner.ts");
  });

  it("does not group findings from different subsystems even when category matches", () => {
    const findings = makeCrossFileSubsystemFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-sub", findings });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const loopPacket = output.packets.find((p) =>
      p.allowedScope.includes("src/loop/worker.ts"),
    );
    expect(loopPacket).toBeDefined();
    expect(loopPacket!.findingIds).toEqual(["f-sub-c"]);
  });

  it("detects overlapping scope as a conflict and marks packets parallel-unsafe", () => {
    const findings = makeOverlappingScopeFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-overlap", findings });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    expect(output.packets.length).toBe(1);
    const packet = output.packets[0];
    expect(packet.parallelGroup).toBe("g-000");
    expect(packet.conflicts).toEqual([]);
  });

  it("escalates high-risk security/auth findings to operator-review with Medic flag", () => {
    const findings = makeHighRiskFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-risk", findings });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const securityPackets = output.packets.filter((p) =>
      p.allowedScope.some((s) => s.includes("token.ts")),
    );
    expect(securityPackets.length).toBe(1);
    expect(securityPackets[0].routingTarget).toBe("operator-review");
    expect(securityPackets[0].medic).toBe(true);
    expect(securityPackets[0].prohibitedScope.length).toBeGreaterThan(0);
  });

  it("escalates migration/governance findings to operator-review", () => {
    const findings = makeHighRiskFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-risk", findings });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const migrationPacket = output.packets.find((p) =>
      p.allowedScope.includes("src/db/migrate.ts"),
    );
    expect(migrationPacket).toBeDefined();
    expect(migrationPacket!.routingTarget).toBe("operator-review");
    expect(migrationPacket!.medic).toBe(true);
  });

  it("routes low-confidence and broad findings to follow-up or repair-worker", () => {
    const findings = makeLowConfidenceBroadFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-broad", findings });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const broadMedium = output.packets.find((p) => p.findingIds.includes("f-broad-1"));
    expect(broadMedium).toBeDefined();
    expect(broadMedium!.routingTarget).toBe("follow-up");

    const unattributed = output.packets.find((p) => p.findingIds.includes("f-broad-2"));
    expect(unattributed).toBeDefined();
    expect(unattributed!.routingTarget).toBe("follow-up");

    const preexisting = output.packets.find((p) => p.findingIds.includes("f-preexisting-1"));
    expect(preexisting).toBeDefined();
    expect(preexisting!.routingTarget).toBe("follow-up");
  });

  it("does not merge high-risk findings with normal repairs", () => {
    const normal: QcFinding = {
      findingId: "f-normal-1",
      severity: "medium",
      category: "style",
      title: "normal",
      fixAvailable: true,
      autofixEligible: true,
      attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-1" },
      status: "open",
      filePath: "src/auth/login.ts",
    };
    const security: QcFinding = {
      findingId: "f-security-mixed",
      severity: "medium",
      category: "security",
      title: "security",
      fixAvailable: true,
      autofixEligible: false,
      attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-1" },
      status: "open",
      filePath: "src/auth/login.ts",
    };
    const result: QcResult = makeResult({
      qcRunId: "qc-run-mixed",
      findings: [normal, security],
    });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const packets = output.packets.filter((p) => p.allowedScope.includes("src/auth/login.ts"));
    expect(packets.length).toBe(2);
    expect(packets.map((p) => p.routingTarget)).toEqual(
      expect.arrayContaining(["original-worker", "operator-review"]),
    );
  });

  it("emits deterministic output for the same inputs", () => {
    const findings = makeCrossFileSubsystemFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-det", findings });
    const input = {
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    };
    const first = compileRepairPackets(input);
    const second = compileRepairPackets(input);

    expect(first.packets).toEqual(second.packets);
    expect(first.manifest).toEqual(second.manifest);
  });

  it("creates a Medic packet for provider failure artifacts", () => {
    const failed: QcResult = makeResult({
      qcRunId: "qc-run-failed",
      status: "failed",
      allProvidersFailed: true,
      findings: [],
    });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [failed],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    expect(output.packets.length).toBe(1);
    const packet = output.packets[0];
    expect(packet.routingTarget).toBe("operator-review");
    expect(packet.medic).toBe(true);
    expect(packet.allowedScope).toEqual([]);
    expect(packet.prohibitedScope).toContain("**/*");
    expect(packet.findingIds).toEqual([]);
  });

  it("produces no repair-worker packets when all providers failed", () => {
    const failed: QcResult = makeResult({
      qcRunId: "qc-run-all-failed",
      status: "failed",
      allProvidersFailed: true,
      findings: [],
    });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [failed],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const repairPackets = output.packets.filter((p) => p.routingTarget === "repair-worker");
    expect(repairPackets).toHaveLength(0);
    expect(output.packets.every((p) => p.routingTarget === "operator-review")).toBe(true);
  });

  it("assigns disjoint packets to different parallel groups", () => {
    const findings: QcFinding[] = [
      {
        findingId: "f-a",
        severity: "low",
        category: "style",
        title: "a",
        fixAvailable: true,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-1" },
        status: "open",
        filePath: "src/a.ts",
      },
      {
        findingId: "f-b",
        severity: "low",
        category: "style",
        title: "b",
        fixAvailable: true,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-2" },
        status: "open",
        filePath: "src/b.ts",
      },
    ];
    const result: QcResult = makeResult({ qcRunId: "qc-run-parallel", findings });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    expect(output.packets.length).toBe(2);
    const groups = new Set(output.packets.map((p) => p.parallelGroup));
    expect(groups.size).toBe(1);
    expect(output.packets[0].conflicts).toEqual([]);
    expect(output.packets[1].conflicts).toEqual([]);
  });

  it("strips waived/autofixed/repaired findings from packets", () => {
    const findings: QcFinding[] = [
      {
        findingId: "f-active",
        severity: "low",
        category: "style",
        title: "active",
        fixAvailable: true,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-1" },
        status: "open",
        filePath: "src/a.ts",
      },
      {
        findingId: "f-waived",
        severity: "low",
        category: "style",
        title: "waived",
        fixAvailable: true,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-1" },
        status: "waived",
        filePath: "src/a.ts",
      },
    ];
    const result: QcResult = makeResult({ qcRunId: "qc-run-status", findings });
    const output = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    expect(output.packets.length).toBe(1);
    expect(output.packets[0].findingIds).toEqual(["f-active"]);
  });
});

describe("QC repair packet artifact persistence", () => {
  const clusterId = "POL-ARTIFACT";
  const round = 1;
  const compiledAt = "2026-07-08T12:00:00.000Z";
  const repoRoot = path.join(process.cwd(), ".test-scratch", `repair-packets-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(repoRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("writes the manifest to the cluster repair-round path", () => {
    const findings = makeSameFileFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-artifact", findings });
    const { manifest, manifestPath } = compileAndWriteRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
      repoRoot,
    });

    expect(manifestPath).toBe(getRepairPacketManifestPath(clusterId, round, repoRoot));
    const read = readRepairPacketManifest(clusterId, round, repoRoot);
    expect(read).not.toBeNull();
    expect(read!.packets).toEqual(manifest.packets);
  });

  it("validates the persisted manifest against the schema", () => {
    const findings = makeCrossFileSubsystemFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-schema", findings });
    const { manifest } = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const validation = validateRepairPacketManifest(manifest);
    expect(validation.success).toBe(true);
  });

  it("returns null for a missing manifest", () => {
    expect(readRepairPacketManifest(clusterId, 9999, repoRoot)).toBeNull();
  });

  it("returns null for an invalid manifest", () => {
    const dir = path.dirname(getRepairPacketManifestPath(clusterId, round, repoRoot));
    mkdirSync(dir, { recursive: true });
    const badManifestPath = getRepairPacketManifestPath(clusterId, round, repoRoot);
    writeRepairPacketManifest(
      {
        schemaVersion: "1.0",
        clusterId,
        round,
        compiledAt,
        sourceQcRunIds: [],
        packets: [],
      },
      repoRoot,
    );
    const valid = readRepairPacketManifest(clusterId, round, repoRoot);
    expect(valid).not.toBeNull();

    // Overwrite with invalid content and ensure validation fails.
    const fs = require("node:fs");
    fs.writeFileSync(badManifestPath, JSON.stringify({ not: "a manifest" }), "utf-8");
    expect(readRepairPacketManifest(clusterId, round, repoRoot)).toBeNull();
  });

  it("writes atomically with a temp file and rename", () => {
    const findings = makeSameFileFindings();
    const result: QcResult = makeResult({ qcRunId: "qc-run-atomic", findings });
    const { manifest } = compileRepairPackets({
      clusterId,
      round,
      qcResults: [result],
      config: DEFAULT_TEST_CONFIG,
      compiledAt,
    });

    const writtenPath = writeRepairPacketManifest(manifest, repoRoot);
    expect(writtenPath).toContain(path.join(".polaris", "clusters", clusterId, "qc", "repair-rounds", String(round), "repair-packets.json"));
    expect(readRepairPacketManifest(clusterId, round, repoRoot)).toEqual(manifest);
  });
});
