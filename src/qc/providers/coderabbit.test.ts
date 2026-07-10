import { describe, expect, it } from "vitest";
import { CodeRabbitQcProvider } from "./coderabbit.js";
import type { QcProviderOutput, QcMetricsPayload } from "../provider.js";

function makeOutput(stdout: string): QcProviderOutput {
  return {
    provider: "coderabbit",
    stdout,
    exitCode: 0,
  };
}

function makeMetrics(data: unknown): QcMetricsPayload {
  return {
    provider: "coderabbit",
    format: "coderabbit",
    data,
  };
}

describe("CodeRabbitQcProvider", () => {
  it("parses a genuine finding with file and title", () => {
    const provider = new CodeRabbitQcProvider();
    const output = makeOutput(JSON.stringify({ severity: "high", file: "src/a.ts", line: 1, title: "Issue A" }));

    const result = provider.parse(output);

    expect(result.status).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("Issue A");
    expect(result.findings[0].filePath).toBe("src/a.ts");
    expect(result.findings[0].severity).toBe("high");
  });

  it("parses a genuine finding with file and message", () => {
    const provider = new CodeRabbitQcProvider();
    const output = makeOutput(
      JSON.stringify({ severity: "medium", file: "src/b.ts", line: 2, message: "Missing guard" }),
    );

    const result = provider.parse(output);

    expect(result.status).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toBe("Missing guard");
    expect(result.findings[0].filePath).toBe("src/b.ts");
  });

  it("parses a message-only finding", () => {
    const provider = new CodeRabbitQcProvider();
    const output = makeOutput(
      JSON.stringify({ severity: "low", message: "Clean up", category: "style" }),
    );

    const result = provider.parse(output);

    expect(result.status).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("style");
    expect(result.findings[0].message).toBe("Clean up");
    expect(result.findings[0].filePath).toBeUndefined();
  });

  it("parses a JSON findings array with genuine records", () => {
    const provider = new CodeRabbitQcProvider();
    const output = makeOutput(
      JSON.stringify({
        findings: [
          { severity: "high", file: "src/a.ts", line: 1, title: "Issue A" },
          { severity: "low", file: "src/b.ts", line: 2, message: "Issue B" },
        ],
      }),
    );

    const result = provider.parse(output);

    expect(result.status).toBe("findings");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].title).toBe("Issue A");
    expect(result.findings[1].title).toBe("Finding #2");
  });

  it("classifies bookkeeping-only JSONL records as unusable-output", () => {
    const provider = new CodeRabbitQcProvider();
    const stdout = [
      { severity: "high", category: "finding", id: "1" },
      { severity: "high", category: "finding", id: "2" },
      { severity: "high", category: "finding", id: "3" },
      { severity: "high", category: "finding", id: "4" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");

    let thrown: unknown;
    try {
      provider.parse(makeOutput(stdout));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { qcFailureReason?: string }).qcFailureReason).toBe("unusable-output");
  });

  it("classifies title-fallback records as unusable-output", () => {
    const provider = new CodeRabbitQcProvider();
    const stdout = [
      { severity: "high", title: "finding", category: "finding", id: "1" },
      { severity: "high", title: "Issue", category: "Issue", id: "2" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");

    let thrown: unknown;
    try {
      provider.parse(makeOutput(stdout));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { qcFailureReason?: string }).qcFailureReason).toBe("unusable-output");
  });

  it("classifies a JSON findings array of only bookkeeping records as unusable-output", () => {
    const provider = new CodeRabbitQcProvider();
    const output = makeOutput(
      JSON.stringify({
        findings: [
          { severity: "high", category: "finding", id: "1" },
          { severity: "high", category: "finding", id: "2" },
        ],
      }),
    );

    let thrown: unknown;
    try {
      provider.parse(output);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { qcFailureReason?: string }).qcFailureReason).toBe("unusable-output");
  });

  it("keeps genuine findings when mixed with bookkeeping records", () => {
    const provider = new CodeRabbitQcProvider();
    const stdout = [
      { severity: "high", file: "src/a.ts", line: 1, title: "Issue A" },
      { severity: "high", category: "finding", id: "1" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");

    const result = provider.parse(makeOutput(stdout));

    expect(result.status).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("Issue A");
  });

  it("classifies bookkeeping-only metrics payload as unusable-output", () => {
    const provider = new CodeRabbitQcProvider();
    const payload = makeMetrics({
      findings: [{ severity: "high", category: "finding", id: "1" }],
    });

    let thrown: unknown;
    try {
      provider.importMetrics(payload);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { qcFailureReason?: string }).qcFailureReason).toBe("unusable-output");
  });
});
