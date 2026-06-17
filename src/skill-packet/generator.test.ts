import { describe, expect, it } from "vitest";
import { generateSkillPacket, SKILL_ROLE_MAP, SUPPORTED_SKILLS } from "./generator.js";
import type { SkillName } from "./types.js";

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
    expect(SUPPORTED_SKILLS).toEqual(["analyze", "run", "ingest", "promote", "triage", "review"]);
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

  it("each packet has a unique packet_id", () => {
    const p1 = generateSkillPacket("analyze", DEFAULT_CONFIG);
    const p2 = generateSkillPacket("analyze", DEFAULT_CONFIG);
    expect(p1.packet_id).not.toBe(p2.packet_id);
  });
});
