import { describe, it, expect } from "vitest";
import { parseCliArgs, parseSpecPathFromPositional } from "./args.js";

describe("parseCliArgs", () => {
  it("parses --state-file value", () => {
    const r = parseCliArgs(["--state-file", "path/to/state.json"]);
    expect(r.flags["state-file"]).toBe("path/to/state.json");
    expect(r.positional).toEqual([]);
  });

  it("parses boolean flag", () => {
    const r = parseCliArgs(["--json"]);
    expect(r.flags["json"]).toBe(true);
    expect(r.positional).toEqual([]);
  });

  it("parses --dry-run", () => {
    const r = parseCliArgs(["--dry-run"]);
    expect(r.flags["dry-run"]).toBe(true);
  });

  it("collects positional args before flags", () => {
    const r = parseCliArgs(["continue", "--json"]);
    expect(r.positional).toEqual(["continue"]);
    expect(r.flags["json"]).toBe(true);
  });

  it("returns empty flags and positional for empty input", () => {
    const r = parseCliArgs([]);
    expect(r.flags).toEqual({});
    expect(r.positional).toEqual([]);
  });

  it("extracts spec path from positional args", () => {
    expect(parseSpecPathFromPositional(["spec", "./spec.md"])).toBe("./spec.md");
    expect(parseSpecPathFromPositional(["run", "./spec.md"])).toBeNull();
  });
});
