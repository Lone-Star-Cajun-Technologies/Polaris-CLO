import { describe, expect, it } from "vitest";
import { computeAuthorityRisk } from "./authority-risk.js";

describe("computeAuthorityRisk", () => {
  it("returns high for doctrine/active destination", () => {
    expect(computeAuthorityRisk("doctrine-candidate", "smartdocs/doctrine/active/foo.md")).toBe("high");
  });

  it("returns high for architecture destination", () => {
    expect(computeAuthorityRisk("architecture", "smartdocs/architecture/foo.md")).toBe("high");
  });

  it("returns high for decisions destination", () => {
    expect(computeAuthorityRisk("decision", "smartdocs/decisions/foo.md")).toBe("high");
  });

  it("returns high for specs/active destination", () => {
    expect(computeAuthorityRisk("spec-active", "smartdocs/specs/active/foo.md")).toBe("high");
  });

  it("returns medium for doctrine/candidate destination", () => {
    expect(computeAuthorityRisk("doctrine-candidate", "smartdocs/doctrine/candidate/foo.md")).toBe("medium");
  });

  it("returns low for runtime destination", () => {
    expect(computeAuthorityRisk("runtime-summary", "smartdocs/runtime/summaries/foo.md")).toBe("low");
  });

  it("returns low for audit destination", () => {
    expect(computeAuthorityRisk("audit-finding", "smartdocs/audits/findings/foo.md")).toBe("low");
  });

  it("returns low for raw destination", () => {
    expect(computeAuthorityRisk("spec-raw", "smartdocs/raw/foo.md")).toBe("low");
  });

  it("path wins over classification when they disagree", () => {
    // classification says low risk, but destination path is high-authority — path wins
    expect(computeAuthorityRisk("spec-raw", "smartdocs/doctrine/active/foo.md")).toBe("high");
  });

  it("path wins over classification for medium vs high", () => {
    expect(computeAuthorityRisk("doctrine-candidate", "smartdocs/architecture/foo.md")).toBe("high");
  });
});
