import { describe, it, expect } from "vitest";
import { getVersion } from "./version.js";

describe("getVersion", () => {
  it("returns a version string", () => {
    const version = getVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });
});
