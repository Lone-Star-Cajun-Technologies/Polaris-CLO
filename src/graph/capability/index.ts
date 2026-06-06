export interface LanguageCoverageEntry {
  filesDiscovered: number;
  filesSymbolLevel: number;
  filesFileLevel: number;
  filesFailed: number;
  symbolsExtracted: number;
  warnings: string[];
}

export interface GraphCapabilityReport {
  supportedLanguages: string[];
  coverage: Record<string, LanguageCoverageEntry>;
  unsupportedExtensions: string[];
  fallbackFileCount: number;
  symbolLevelPercent: number;
  totalCoveragePercent: number;
}

export class GraphCapabilityRegistry {
  private readonly coverage = new Map<string, LanguageCoverageEntry>();

  private readonly supportedLanguages: string[];

  private readonly unsupportedExtensions = new Set<string>();

  private fallbackFileCount = 0;

  constructor(supportedLanguages: readonly string[]) {
    this.supportedLanguages = Array.from(new Set(supportedLanguages)).sort((left, right) => left.localeCompare(right));
    for (const languageId of this.supportedLanguages) {
      this.coverage.set(languageId, createEmptyCoverageEntry());
    }
  }

  static unsupportedLanguageId(extension: string): string {
    return `unsupported:${normalizeExtension(extension)}`;
  }

  noteUnsupportedExtension(extension: string): void {
    this.unsupportedExtensions.add(normalizeExtension(extension));
  }

  recordSymbolLevel(languageId: string, symbolsExtracted: number, warnings: readonly string[] = []): void {
    const entry = this.ensureEntry(languageId);
    entry.filesDiscovered += 1;
    entry.filesSymbolLevel += 1;
    entry.symbolsExtracted += symbolsExtracted;
    for (const warning of warnings) {
      entry.warnings.push(warning);
    }
  }

  recordFileLevel(languageId: string, warnings: readonly string[] = []): void {
    const entry = this.ensureEntry(languageId);
    entry.filesDiscovered += 1;
    entry.filesFileLevel += 1;
    this.fallbackFileCount += 1;
    for (const warning of warnings) {
      entry.warnings.push(warning);
    }
  }

  recordFailure(languageId: string, warning: string): void {
    const entry = this.ensureEntry(languageId);
    entry.filesDiscovered += 1;
    entry.filesFailed += 1;
    entry.warnings.push(warning);
  }

  buildReport(): GraphCapabilityReport {
    const entries = Array.from(this.coverage.entries()).sort(([left], [right]) => left.localeCompare(right));
    const coverage: Record<string, LanguageCoverageEntry> = {};

    let filesDiscovered = 0;
    let filesSymbolLevel = 0;
    let filesFileLevel = 0;

    for (const [languageId, entry] of entries) {
      coverage[languageId] = {
        filesDiscovered: entry.filesDiscovered,
        filesSymbolLevel: entry.filesSymbolLevel,
        filesFileLevel: entry.filesFileLevel,
        filesFailed: entry.filesFailed,
        symbolsExtracted: entry.symbolsExtracted,
        warnings: [...entry.warnings],
      };
      filesDiscovered += entry.filesDiscovered;
      filesSymbolLevel += entry.filesSymbolLevel;
      filesFileLevel += entry.filesFileLevel;
    }

    return {
      supportedLanguages: [...this.supportedLanguages],
      coverage,
      unsupportedExtensions: Array.from(this.unsupportedExtensions).sort((left, right) => left.localeCompare(right)),
      fallbackFileCount: this.fallbackFileCount,
      symbolLevelPercent: toPercent(filesSymbolLevel, filesDiscovered),
      totalCoveragePercent: toPercent(filesSymbolLevel + filesFileLevel, filesDiscovered),
    };
  }

  private ensureEntry(languageId: string): LanguageCoverageEntry {
    let entry = this.coverage.get(languageId);
    if (!entry) {
      entry = createEmptyCoverageEntry();
      this.coverage.set(languageId, entry);
    }
    return entry;
  }
}

function createEmptyCoverageEntry(): LanguageCoverageEntry {
  return {
    filesDiscovered: 0,
    filesSymbolLevel: 0,
    filesFileLevel: 0,
    filesFailed: 0,
    symbolsExtracted: 0,
    warnings: [],
  };
}

function normalizeExtension(extension: string): string {
  const normalized = extension.trim().toLowerCase();
  if (!normalized) {
    return "<none>";
  }
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function toPercent(coveredFiles: number, discoveredFiles: number): number {
  if (discoveredFiles <= 0) {
    return 0;
  }
  return Math.round((coveredFiles / discoveredFiles) * 1000) / 10;
}
