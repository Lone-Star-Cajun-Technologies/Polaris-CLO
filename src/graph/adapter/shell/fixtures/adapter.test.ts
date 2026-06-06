import { describe, expect, it } from "vitest";
import { createShellAdapter } from "../index.js";

describe("ShellAdapter", () => {
  it("extracts function declarations from both shell function styles", async () => {
    const source = `
function start_service() {
  echo start
}

cleanup() {
  echo cleanup
}
`;

    const adapter = createShellAdapter();
    const extracted = await adapter.extractSymbols("sample.sh", source);

    expect(extracted.language).toBe("shell");
    expect(extracted.symbols.map((symbol) => ({ kind: symbol.kind, name: symbol.name }))).toEqual([
      { kind: "function", name: "start_service" },
      { kind: "function", name: "cleanup" },
    ]);
  });
});
