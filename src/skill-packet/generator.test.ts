import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { generateSkillPacket, generateSetupBootstrapPacket, SKILL_ROLE_MAP, SUPPORTED_SKILLS } from "./generator.js";
import type { SkillName, SetupBootstrapCheckpoint, ReconcilePacket } from "./types.js";

function createReconcileFixture(): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "reconcile-"));

  mkdirSync(path.join(repoRoot, "src", "route"), { recursive: true });
  mkdirSync(path.join(repoRoot, ".polaris", "map"), { recursive: true });
  mkdirSync(path.join(repoRoot, ".taskchain_artifacts", "polaris-run"), { recursive: true });

  writeFileSync(path.join(repoRoot, "src", "route", "changed.ts"), "export const x = 1;\n");
  writeFileSync(path.join(repoRoot, "src", "route", "POLARIS.md"), "# Route POLARIS\n");
  writeFileSync(path.join(repoRoot, "src", "route", "SUMMARY.md"), "# Route SUMMARY\n");
  writeFileSync(
    path.join(repoRoot, ".polaris", "map", "file-routes.json"),
    JSON.stringify({
      "src/route/changed.ts": { route: "src/route" },
    }),
  );
  writeFileSync(
    path.join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json"),
    JSON.stringify({ active_child: "POL-999" }),
  );

  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });

  execFileSync("git", ["checkout", "-b", "pol-999-delivery"], { cwd: repoRoot });
  writeFileSync(path.join(repoRoot, "src", "route", "changed.ts"), "export const x = 2;\n");
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "change"], { cwd: repoRoot });

  return repoRoot;
}

function createEmptyReconcileFixture(): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "reconcile-empty-"));
  mkdirSync(path.join(repoRoot, ".polaris", "map"), { recursive: true });
  mkdirSync(path.join(repoRoot, "src", "route"), { recursive: true });

  writeFileSync(path.join(repoRoot, "src", "route", "unchanged.ts"), "export const x = 1;\n");
  writeFileSync(path.join(repoRoot, "src", "route", "POLARIS.md"), "# Route POLARIS\n");
  writeFileSync(
    path.join(repoRoot, ".polaris", "map", "file-routes.json"),
    JSON.stringify({
      "src/route/unchanged.ts": { route: "src/route" },
    }),
  );

  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });

  return repoRoot;
}

const DEFAULT_CONFIG = {
  analysis_confidence_threshold: 85,
  auto_deep_analysis: false,
  allow_cross_provider_delegation: false,
};

describe("SKILL_ROLE_MAP", () => {
  it("maps analyze to Analyst", () => {
    expect(SKILL_ROLE_MAP.analyze).toBe("Analyst");
  });

  it("maps run to Foreman", () => {
    expect(SKILL_ROLE_MAP.run).toBe("Foreman");
  });

  it("maps ingest to Librarian", () => {
    expect(SKILL_ROLE_MAP.ingest).toBe("Librarian");
  });

  it("maps promote to Librarian", () => {
    expect(SKILL_ROLE_MAP.promote).toBe("Librarian");
  });
});

describe("SUPPORTED_SKILLS", () => {
  it("includes all supported skills", () => {
    expect(SUPPORTED_SKILLS).toEqual([
      "analyze",
      "run",
      "ingest",
      "promote",
      "triage",
      "review",
      "catalog",
      "reconcile",
    ]);
  });
});

describe("generateSkillPacket", () => {
  it.each(SUPPORTED_SKILLS)("generates a packet for %s with required fields", (skill) => {
    const packet = generateSkillPacket(skill as SkillName, DEFAULT_CONFIG);

    expect(packet.packet_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(packet.skill_name).toBe(skill);
    expect(packet.active_role).toBe(SKILL_ROLE_MAP[skill as SkillName]);
    expect(typeof packet.role_summary).toBe("string");
    expect(packet.role_summary.length).toBeGreaterThan(0);
    expect(Array.isArray(packet.authority_boundaries)).toBe(true);
    expect(packet.authority_boundaries.length).toBeGreaterThan(0);
    expect(Array.isArray(packet.prohibited_actions)).toBe(true);
    expect(packet.prohibited_actions.length).toBeGreaterThan(0);
    expect(Array.isArray(packet.allowed_outputs)).toBe(true);
    expect(packet.allowed_outputs.length).toBeGreaterThan(0);
    expect(Array.isArray(packet.deliverables)).toBe(true);
    expect(packet.deliverables.length).toBeGreaterThan(0);
    expect(Array.isArray(packet.stop_conditions)).toBe(true);
    expect(packet.stop_conditions.length).toBeGreaterThan(0);
    expect(typeof packet.generated_at).toBe("string");
    expect(new Date(packet.generated_at).toISOString()).toBe(packet.generated_at);
    expect(packet.source_config_snapshot).toEqual(DEFAULT_CONFIG);
  });

  describe("analyze packet", () => {
    it("assigns Analyst role", () => {
      const packet = generateSkillPacket("analyze", DEFAULT_CONFIG);
      expect(packet.active_role).toBe("Analyst");
    });

    it("includes a confidence_policy", () => {
      const packet = generateSkillPacket("analyze", DEFAULT_CONFIG);
      expect(packet.confidence_policy).toBeDefined();
      expect(packet.confidence_policy?.threshold).toBe(85);
      expect(packet.confidence_policy?.auto_deep_analysis).toBe(false);
      expect(packet.confidence_policy?.on_below_threshold).toBe("ask_user");
    });

    it("sets on_below_threshold to auto_proceed when auto_deep_analysis is true", () => {
      const packet = generateSkillPacket("analyze", {
        ...DEFAULT_CONFIG,
        auto_deep_analysis: true,
      });
      expect(packet.confidence_policy?.on_below_threshold).toBe("auto_proceed");
      expect(packet.confidence_policy?.auto_deep_analysis).toBe(true);
    });

    it("reflects custom confidence threshold in policy and snapshot", () => {
      const packet = generateSkillPacket("analyze", {
        ...DEFAULT_CONFIG,
        analysis_confidence_threshold: 70,
      });
      expect(packet.confidence_policy?.threshold).toBe(70);
      expect(packet.source_config_snapshot.analysis_confidence_threshold).toBe(70);
    });

    it("prohibits implementation actions", () => {
      const packet = generateSkillPacket("analyze", DEFAULT_CONFIG);
      const prohibited = packet.prohibited_actions.join(" ");
      expect(prohibited).toContain("production or runtime code");
      expect(prohibited).toContain("polaris loop continue");
    });
  });

  describe("run packet", () => {
    it("assigns Foreman role", () => {
      const packet = generateSkillPacket("run", DEFAULT_CONFIG);
      expect(packet.active_role).toBe("Foreman");
    });

    it("does not include a confidence_policy", () => {
      const packet = generateSkillPacket("run", DEFAULT_CONFIG);
      expect(packet.confidence_policy).toBeUndefined();
    });

    it("prohibits inline implementation", () => {
      const packet = generateSkillPacket("run", DEFAULT_CONFIG);
      const prohibited = packet.prohibited_actions.join(" ");
      expect(prohibited).toContain("inline implementation");
    });

    it("notes cross-provider delegation is NOT permitted by default", () => {
      const packet = generateSkillPacket("run", DEFAULT_CONFIG);
      const boundaries = packet.authority_boundaries.join(" ");
      expect(boundaries).toContain("NOT permitted");
    });

    it("notes cross-provider delegation is permitted when configured", () => {
      const packet = generateSkillPacket("run", {
        ...DEFAULT_CONFIG,
        allow_cross_provider_delegation: true,
      });
      const boundaries = packet.authority_boundaries.join(" ");
      expect(boundaries).toContain("permitted per configuration");
    });

    it("requires Worker result evidence before marking complete", () => {
      const packet = generateSkillPacket("run", DEFAULT_CONFIG);
      const stops = packet.stop_conditions.join(" ");
      expect(stops).toContain("Worker result evidence");
    });

    describe("run packet delegation note", () => {
      it("when allow_cross_provider_delegation is false, provides delegation policy with allowed adapters", () => {
        const packet = generateSkillPacket("run", {
          ...DEFAULT_CONFIG,
          allow_cross_provider_delegation: false,
        });
        const note = packet.authority_boundaries.find((b) => b.startsWith("Delegation policy:"));
        expect(note).toBeDefined();
        expect(note).toContain("NOT permitted");
        expect(note).toMatch(/(terminal-cli|interactive-agent|agent-subtask)/);
        expect(note).toContain("prohibited");
      });

      it("when allow_cross_provider_delegation is true, permits cross-provider delegation", () => {
        const packet = generateSkillPacket("run", {
          ...DEFAULT_CONFIG,
          allow_cross_provider_delegation: true,
        });
        const note = packet.authority_boundaries.find((b) => b.startsWith("Delegation policy:"));
        expect(note).toBeDefined();
        expect(note).toContain("permitted");
      });
    });
  });

  describe("ingest packet", () => {
    it("assigns Librarian role", () => {
      const packet = generateSkillPacket("ingest", DEFAULT_CONFIG);
      expect(packet.active_role).toBe("Librarian");
    });

    it("does not include a confidence_policy", () => {
      const packet = generateSkillPacket("ingest", DEFAULT_CONFIG);
      expect(packet.confidence_policy).toBeUndefined();
    });

    it("prohibits promoting to active without approval", () => {
      const packet = generateSkillPacket("ingest", DEFAULT_CONFIG);
      const prohibited = packet.prohibited_actions.join(" ");
      expect(prohibited).toContain("doctrine/active/");
    });
  });

  describe("promote packet", () => {
    it("assigns Librarian role", () => {
      const packet = generateSkillPacket("promote", DEFAULT_CONFIG);
      expect(packet.active_role).toBe("Librarian");
    });

    it("does not include a confidence_policy", () => {
      const packet = generateSkillPacket("promote", DEFAULT_CONFIG);
      expect(packet.confidence_policy).toBeUndefined();
    });

    it("prohibits auto-promote without surfacing conflict report", () => {
      const packet = generateSkillPacket("promote", DEFAULT_CONFIG);
      const prohibited = packet.prohibited_actions.join(" ");
      expect(prohibited).toContain("Auto-promote");
    });

    it("prohibits calling --approve without user confirmation", () => {
      const packet = generateSkillPacket("promote", DEFAULT_CONFIG);
      const prohibited = packet.prohibited_actions.join(" ");
      expect(prohibited).toContain("--approve");
    });
  });

  describe("catalog packet", () => {
    it("authorizes bounded cognition and raw document classification", () => {
      const packet = generateSkillPacket("catalog", DEFAULT_CONFIG);

      expect(packet.active_role).toBe("Librarian");
      expect(packet.authority_boundaries.join(" ")).toContain("smartdocs/raw/");
      expect(packet.allowed_outputs.join(" ")).toContain("POLARIS.md");
      expect(packet.prohibited_actions.join(" ")).toContain("low-confidence");
      expect(packet.prohibited_actions.join(" ")).toContain("Git push");
    });
  });

  describe("reconcile packet", () => {
    it("authorizes cognition updates while prohibiting document lifecycle actions", () => {
      const packet = generateSkillPacket("reconcile", DEFAULT_CONFIG);

      expect(packet.active_role).toBe("Librarian");
      expect(packet.allowed_outputs.join(" ")).toContain("SUMMARY.md");
      expect(packet.prohibited_actions.join(" ")).toContain("Move, ingest, classify, or promote documents");
      expect(packet.prohibited_actions.join(" ")).toContain("source code");
    });

    describe("with real git diff and map", () => {
      let repoRoot: string;
      let packet: ReconcilePacket;

      beforeAll(() => {
        repoRoot = createReconcileFixture();
        packet = generateSkillPacket("reconcile", DEFAULT_CONFIG, { repoRoot });
      });

      afterAll(() => {
        rmSync(repoRoot, { recursive: true, force: true });
      });

      it("returns a ReconcilePacket with packet_kind and issue_id", () => {
        expect(packet.packet_kind).toBe("reconcile");
        expect(packet.issue_id).toBe("POL-999");
        expect(packet.run_id).toMatch(/^polaris-reconcile-POL-999-/);
      });

      it("populates affected_folders from git diff cross-referenced with file-routes.json", () => {
        expect(packet.affected_folders).toEqual(["src/route/"]);
      });

      it("populates work_inventory with changed files and current cognition content", () => {
        const workInventory = packet.work_inventory;

        expect(workInventory.all_changed_files).toContain("src/route/changed.ts");
        expect(workInventory.affected_folders).toEqual(["src/route/"]);
        expect(workInventory.polaris_md_files["src/route/"]).toBe("# Route POLARIS\n");
        expect(workInventory.summary_md_files["src/route/"]).toBe("# Route SUMMARY\n");
      });

      it("restricts allowed_write_paths to POLARIS.md and SUMMARY.md under affected folders", () => {
        const allowed = packet.allowed_write_paths;
        const polarisMd = path.join(repoRoot, "src", "route", "POLARIS.md");
        const summaryMd = path.join(repoRoot, "src", "route", "SUMMARY.md");

        expect(allowed).toContain(polarisMd);
        expect(allowed).toContain(summaryMd);
        expect(allowed.length).toBe(2);
      });

      it("covers the repo root in prohibited_write_paths", () => {
        expect(packet.prohibited_write_paths).toContain(repoRoot);
      });
    });

    describe("with no git diff to inspect", () => {
      let repoRoot: string;
      let packet: ReconcilePacket;

      beforeAll(() => {
        repoRoot = createEmptyReconcileFixture();
        packet = generateSkillPacket("reconcile", DEFAULT_CONFIG, { repoRoot });
      });

      afterAll(() => {
        rmSync(repoRoot, { recursive: true, force: true });
      });

      it("falls back to an empty/blocked state", () => {
        const workInventory = packet.work_inventory;

        expect(packet.affected_folders).toEqual([]);
        expect(packet.allowed_write_paths).toEqual([]);
        expect(workInventory.affected_folders).toEqual([]);
        expect(workInventory.all_changed_files).toEqual([]);
        expect(Object.keys(workInventory.polaris_md_files)).toEqual([]);
        expect(Object.keys(workInventory.summary_md_files)).toEqual([]);
        expect(packet.prohibited_actions.join(" ")).toContain("Fabricate");
      });
    });
  });

  it("each packet has a unique packet_id", () => {
    const p1 = generateSkillPacket("analyze", DEFAULT_CONFIG);
    const p2 = generateSkillPacket("analyze", DEFAULT_CONFIG);
    expect(p1.packet_id).not.toBe(p2.packet_id);
  });
});

const EXPECTED_CHECKPOINTS: SetupBootstrapCheckpoint[] = [
  "canon",
  "doc-movement",
  "instruction-files",
  "graph-root",
  "route-scaffold",
  "source-mutation",
];

describe("generateSetupBootstrapPacket", () => {
  it.each(["init", "adopt"] as const)("generates a valid packet for mode %s", (mode) => {
    const packet = generateSetupBootstrapPacket(mode);
    expect(packet.packet_kind).toBe("setup-bootstrap");
    expect(packet.active_role).toBe("Foreman");
    expect(packet.mode).toBe(mode);
    expect(packet.packet_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("includes all expected approval_checkpoints", () => {
    const packet = generateSetupBootstrapPacket("init");
    expect(packet.approval_checkpoints).toEqual(EXPECTED_CHECKPOINTS);
  });

  it("embeds a checkpoint_gate with self_approval_prohibited: true", () => {
    const packet = generateSetupBootstrapPacket("init");
    expect(packet.checkpoint_gate).toBeDefined();
    expect(packet.checkpoint_gate.self_approval_prohibited).toBe(true);
  });

  it("checkpoint_gate has a gate entry for every checkpoint", () => {
    const packet = generateSetupBootstrapPacket("init");
    for (const checkpoint of EXPECTED_CHECKPOINTS) {
      expect(packet.checkpoint_gate.gates[checkpoint]).toBeDefined();
      expect(packet.checkpoint_gate.gates[checkpoint]).toContain("HALT");
      expect(packet.checkpoint_gate.gates[checkpoint]).toContain("You may not self-approve");
    }
  });

  it("each gate instruction names its checkpoint", () => {
    const packet = generateSetupBootstrapPacket("adopt");
    for (const checkpoint of EXPECTED_CHECKPOINTS) {
      expect(packet.checkpoint_gate.gates[checkpoint]).toContain(checkpoint);
    }
  });

  it("checkpoint_gate.enforcement_note is non-empty and references halting", () => {
    const packet = generateSetupBootstrapPacket("init");
    expect(packet.checkpoint_gate.enforcement_note.length).toBeGreaterThan(0);
    expect(packet.checkpoint_gate.enforcement_note).toContain("halt");
  });

  it("prohibited_actions forbids self-approval", () => {
    const packet = generateSetupBootstrapPacket("init");
    const prohibited = packet.prohibited_actions.join(" ");
    expect(prohibited).toContain("Self-approve");
    expect(prohibited).toContain("operator approval");
  });

  it("stop_conditions require halting at each checkpoint", () => {
    const packet = generateSetupBootstrapPacket("init");
    const stops = packet.stop_conditions.join(" ");
    expect(stops).toContain("approval checkpoint");
    expect(stops).toContain("pause");
  });

  it("each packet has a unique packet_id", () => {
    const p1 = generateSetupBootstrapPacket("init");
    const p2 = generateSetupBootstrapPacket("init");
    expect(p1.packet_id).not.toBe(p2.packet_id);
  });
});
