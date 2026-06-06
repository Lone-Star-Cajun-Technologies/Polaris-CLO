import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractShellSymbolsFromSource } from "./extract.js";

const DEFAULT_EXTENSIONS = [".sh", ".bash", ".zsh"] as const;

export class ShellAdapter implements LanguageAdapter {
  readonly languageId = "shell";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "low" as const;

  readonly limitations = [
    "Uses regex-based function extraction (phase 1 heuristic).",
    "Does not parse shell includes (source/dot) or dynamic function definitions.",
  ] as const;

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const extension = extname(filePath).toLowerCase();
    if (!DEFAULT_EXTENSIONS.includes(extension as (typeof DEFAULT_EXTENSIONS)[number])) {
      throw new Error(`Unsupported shell file extension: ${extension}`);
    }
    return extractShellSymbolsFromSource(source);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createShellAdapter(): ShellAdapter {
  return new ShellAdapter();
}
