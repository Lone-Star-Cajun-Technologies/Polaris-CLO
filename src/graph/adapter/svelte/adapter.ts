import { basename, extname } from "node:path";
import type { AdapterExtractionResult, ExtractedSymbol, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { createTypeScriptJavaScriptAdapter } from "../typescript-javascript/index.js";
import { extractSvelteScriptBlocks, type SvelteScriptBlock } from "./extract.js";

const DEFAULT_EXTENSIONS = [".svelte"] as const;

interface ScriptDelegate {
  extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult>;
  resolveImportSpecifier(specifier: string, context: ImportResolutionContext): string | null;
}

export interface SvelteAdapterOptions {
  scriptDelegate?: ScriptDelegate;
}

export class SvelteAdapter implements LanguageAdapter {
  readonly languageId = "svelte";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "medium" as const;

  readonly limitations = [
    "Extracts declaration-level symbols from <script> blocks by delegating to the TypeScript/JavaScript adapter.",
    "Does not parse markup/template-level symbols or <style> blocks.",
  ] as const;

  constructor(private readonly scriptDelegate: ScriptDelegate) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    if (extname(filePath).toLowerCase() !== ".svelte") {
      throw new Error(`Unsupported Svelte file extension: ${extname(filePath)}`);
    }

    const symbols: ExtractedSymbol[] = [createComponentSymbol(filePath)];
    const scriptBlocks = extractSvelteScriptBlocks(source);

    for (const block of scriptBlocks) {
      const delegated = await this.scriptDelegate.extractSymbols(
        toDelegatedFilePath(filePath, block),
        block.content,
      );
      symbols.push(...delegated.symbols.map((symbol) => offsetSymbol(symbol, block)));
    }

    return {
      language: "svelte",
      symbols: dedupeAndSort(symbols),
    };
  }

  resolveImportSpecifier(specifier: string, context: ImportResolutionContext): string | null {
    return this.scriptDelegate.resolveImportSpecifier(specifier, context);
  }
}

export function createSvelteAdapter(options: SvelteAdapterOptions = {}): SvelteAdapter {
  return new SvelteAdapter(options.scriptDelegate ?? createTypeScriptJavaScriptAdapter());
}

function createComponentSymbol(filePath: string): ExtractedSymbol {
  const componentName = basename(filePath, extname(filePath));
  return {
    kind: "class",
    name: componentName,
    signature: null,
    exported: true,
    startLine: 1,
    startColumn: 0,
    endLine: 1,
    endColumn: componentName.length,
  };
}

function toDelegatedFilePath(filePath: string, block: SvelteScriptBlock): string {
  return block.language === "typescript" ? `${filePath}.ts` : `${filePath}.js`;
}

function offsetSymbol(symbol: ExtractedSymbol, block: SvelteScriptBlock): ExtractedSymbol {
  const lineOffset = block.startLine - 1;
  return {
    ...symbol,
    startLine: symbol.startLine + lineOffset,
    endLine: symbol.endLine + lineOffset,
    startColumn: symbol.startLine === 1 ? symbol.startColumn + block.startColumn : symbol.startColumn,
    endColumn: symbol.endLine === 1 ? symbol.endColumn + block.startColumn : symbol.endColumn,
  };
}

function dedupeAndSort(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  const byFingerprint = new Map<string, ExtractedSymbol>();
  for (const symbol of symbols) {
    const fingerprint = [
      symbol.kind,
      symbol.name,
      symbol.startLine,
      symbol.startColumn,
      symbol.endLine,
      symbol.endColumn,
    ].join(":");
    byFingerprint.set(fingerprint, symbol);
  }

  return Array.from(byFingerprint.values()).sort((left, right) => {
    return (
      left.startLine - right.startLine ||
      left.startColumn - right.startColumn ||
      left.endLine - right.endLine ||
      left.endColumn - right.endColumn ||
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name)
    );
  });
}
