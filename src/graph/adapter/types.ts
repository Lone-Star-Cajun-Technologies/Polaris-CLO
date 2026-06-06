import type { GraphSymbolKind } from "../store/types.js";

export interface ExtractedSymbol {
  kind: Exclude<GraphSymbolKind, "unknown">;
  name: string;
  signature: string | null;
  exported: boolean;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface AdapterExtractionResult {
  language: string;
  symbols: ExtractedSymbol[];
}

export interface ImportResolutionContext {
  fromFilePath: string;
  candidateExtensions?: readonly string[];
}

export interface LanguageAdapter {
  languageId: string;
  fileExtensions: readonly string[];
  confidence: "high" | "medium" | "low";
  limitations: readonly string[];
  extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult>;
  resolveImportSpecifier(specifier: string, context: ImportResolutionContext): string | null;
}

export interface AdapterRegistry {
  register(adapter: LanguageAdapter): void;
  getForExtension(extension: string): LanguageAdapter | null;
  getSupportedExtensions(): string[];
  getAll(): LanguageAdapter[];
}
