import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import {
  validateSkillChainFile,
  validateSkillChainDirectory,
  validateMapReferences,
} from "./map-reference-validator.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedReaddirSync = vi.mocked(fs.readdirSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateSkillChainFile", () => {
  it("detects 'read all doctrine' pattern", () => {
    mockedReadFileSync.mockReturnValue(
      "Step 1: Read all doctrine before starting work\n",
    );
    const violations = validateSkillChainFile("/test/chain.md");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("navigation-before-retrieval");
    expect(violations[0].message).toContain("broad context preload");
  });

  it("detects 'load all charts' pattern", () => {
    mockedReadFileSync.mockReturnValue(
      "Step 2: Load all charts for context\n",
    );
    const violations = validateSkillChainFile("/test/chain.md");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("navigation-before-retrieval");
  });

  it("detects 'preload linked docs' pattern", () => {
    mockedReadFileSync.mockReturnValue(
      "Preload all linked docs before execution\n",
    );
    const violations = validateSkillChainFile("/test/chain.md");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("navigation-before-retrieval");
  });

  it("detects 'preload documents' pattern", () => {
    mockedReadFileSync.mockReturnValue(
      "Preload all documents from the repository\n",
    );
    const violations = validateSkillChainFile("/test/chain.md");
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("navigation-before-retrieval");
  });

  it("ignores case when detecting patterns", () => {
    mockedReadFileSync.mockReturnValue(
      "READ ALL DOCTRINE before starting\n",
    );
    const violations = validateSkillChainFile("/test/chain.md");
    expect(violations).toHaveLength(1);
  });

  it("reports line number correctly", () => {
    const content =
      "Step 1: Start work\n" +
      "Step 2: Read all doctrine\n" +
      "Step 3: Continue\n";
    mockedReadFileSync.mockReturnValue(content);
    const violations = validateSkillChainFile("/test/chain.md");
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it("returns empty violations for clean file", () => {
    mockedReadFileSync.mockReturnValue(
      "Step 1: Start work\n" +
      "Step 2: Read specific doc when needed\n" +
      "Step 3: Continue\n",
    );
    const violations = validateSkillChainFile("/test/chain.md");
    expect(violations).toHaveLength(0);
  });

  it("handles file read errors gracefully", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("File not found");
    });
    const violations = validateSkillChainFile("/test/chain.md");
    expect(violations).toHaveLength(0);
  });
});

describe("validateSkillChainDirectory", () => {
  it("checks chain.md files in directory", () => {
    mockedReaddirSync.mockReturnValue([
      { name: "chain.md", isDirectory: () => false },
      { name: "SKILL.md", isDirectory: () => false },
    ] as any);
    mockedReadFileSync.mockReturnValue("Clean content\n");

    const result = validateSkillChainDirectory("/test/skills");
    expect(result.filesChecked).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it("recursively checks subdirectories", () => {
    mockedReaddirSync
      .mockReturnValueOnce([
        { name: "subdir", isDirectory: () => true },
        { name: "chain.md", isDirectory: () => false },
      ] as any)
      .mockReturnValueOnce([
        { name: "chain.md", isDirectory: () => false },
      ] as any);
    mockedReadFileSync.mockReturnValue("Clean content\n");

    const result = validateSkillChainDirectory("/test/skills");
    expect(result.filesChecked).toBe(2);
  });

  it("aggregates violations from all chain.md files", () => {
    mockedReaddirSync.mockReturnValue([
      { name: "chain.md", isDirectory: () => false },
    ] as any);
    mockedReadFileSync.mockReturnValue("Read all doctrine\n");

    const result = validateSkillChainDirectory("/test/skills");
    expect(result.violations).toHaveLength(1);
  });

  it("handles directory read errors gracefully", () => {
    mockedReaddirSync.mockImplementation(() => {
      throw new Error("Directory not found");
    });

    const result = validateSkillChainDirectory("/test/skills");
    expect(result.filesChecked).toBe(0);
    expect(result.violations).toHaveLength(0);
  });
});

describe("validateMapReferences", () => {
  it("validates .polaris/skills directory", () => {
    mockedReaddirSync.mockReturnValue([
      { name: "chain.md", isDirectory: () => false },
    ] as any);
    mockedReadFileSync.mockReturnValue("Clean content\n");

    const result = validateMapReferences("/repo");
    expect(result.filesChecked).toBe(1);
    expect(result.violations).toHaveLength(0);
  });
});