import { describe, expect, it, vi } from "vitest";
import { createSvelteAdapter } from "../index.js";
import type { AdapterExtractionResult, ExtractedSymbol, ImportResolutionContext } from "../../types.js";

describe("SvelteAdapter", () => {
  it("extracts symbols from a basic component <script> block and emits the component symbol", async () => {
    const delegatedSymbols = [
      symbol("function", "load", 1, 0, 1, 24, true),
      symbol("class", "LocalWorker", 2, 0, 4, 1, false),
    ];
    const delegate = createDelegate(async () => ({ language: "javascript", symbols: delegatedSymbols }));
    const adapter = createSvelteAdapter({ scriptDelegate: delegate });

    const extracted = await adapter.extractSymbols(
      "BasicComponent.svelte",
      `<script>\nexport function load() {}\nclass LocalWorker {}\n</script>\n<div />\n`,
    );

    expect(extracted.language).toBe("svelte");
    expect(extracted.symbols.map((entry) => ({ kind: entry.kind, name: entry.name, exported: entry.exported }))).toEqual([
      { kind: "class", name: "BasicComponent", exported: true },
      { kind: "function", name: "load", exported: true },
      { kind: "class", name: "LocalWorker", exported: false },
    ]);
    expect(delegate.extractSymbols).toHaveBeenCalledWith("BasicComponent.svelte.js", "\nexport function load() {}\nclass LocalWorker {}\n");
  });

  it("delegates <script lang=\"ts\"> blocks to TypeScript extraction", async () => {
    const delegate = createDelegate(async () => ({
      language: "typescript",
      symbols: [symbol("function", "bootstrap", 1, 0, 1, 35, true)],
    }));
    const adapter = createSvelteAdapter({ scriptDelegate: delegate });

    const extracted = await adapter.extractSymbols(
      "TypedComponent.svelte",
      `<script lang="ts">\nexport function bootstrap(input: string) {}\n</script>\n`,
    );

    expect(extracted.symbols.map((entry) => entry.name)).toEqual(["TypedComponent", "bootstrap"]);
    expect(delegate.extractSymbols).toHaveBeenCalledWith(
      "TypedComponent.svelte.ts",
      "\nexport function bootstrap(input: string) {}\n",
    );
  });

  it("returns only the component symbol when no <script> block is present", async () => {
    const delegate = createDelegate(async () => ({ language: "javascript", symbols: [] }));
    const adapter = createSvelteAdapter({ scriptDelegate: delegate });

    const extracted = await adapter.extractSymbols("NoScript.svelte", "<div>No script here</div>\n");

    expect(extracted.symbols).toEqual([
      {
        kind: "class",
        name: "NoScript",
        signature: null,
        exported: true,
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 8,
      },
    ]);
    expect(delegate.extractSymbols).not.toHaveBeenCalled();
  });

  it("captures multiple exported symbols across multiple script blocks", async () => {
    const delegate = createDelegate(async (_filePath, source) => {
      if (source.includes("export const alpha")) {
        return {
          language: "javascript",
          symbols: [
            symbol("function", "alpha", 1, 0, 1, 22, true),
            symbol("function", "beta", 2, 0, 2, 21, true),
          ],
        };
      }
      return {
        language: "typescript",
        symbols: [symbol("function", "gamma", 1, 0, 1, 22, true)],
      };
    });
    const adapter = createSvelteAdapter({ scriptDelegate: delegate });

    const source = `<script>\nexport const alpha = () => 1;\nexport const beta = () => 2;\n</script>\n<section />\n<script lang="ts">\nexport const gamma = () => 3;\n</script>\n`;
    const extracted = await adapter.extractSymbols("MultiExport.svelte", source);

    expect(extracted.symbols.map((entry) => entry.name)).toEqual([
      "MultiExport",
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(delegate.extractSymbols).toHaveBeenCalledTimes(2);
  });
});

interface ScriptDelegate {
  extractSymbols: (filePath: string, source: string) => Promise<AdapterExtractionResult>;
  resolveImportSpecifier: (specifier: string, context: ImportResolutionContext) => string | null;
}

function createDelegate(
  extractSymbols: (filePath: string, source: string) => Promise<AdapterExtractionResult>,
): ScriptDelegate & { extractSymbols: ReturnType<typeof vi.fn> } {
  return {
    extractSymbols: vi.fn(extractSymbols),
    resolveImportSpecifier: (specifier) => specifier,
  };
}

function symbol(
  kind: ExtractedSymbol["kind"],
  name: string,
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  exported: boolean,
): ExtractedSymbol {
  return {
    kind,
    name,
    signature: null,
    exported,
    startLine,
    startColumn,
    endLine,
    endColumn,
  };
}
