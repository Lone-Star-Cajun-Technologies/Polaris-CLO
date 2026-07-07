import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptions,
} from "node:child_process";
import { describe, expect, it } from "vitest";
import type { IQcProvider, QcReviewScope } from "./provider.js";
import { executeQcProvider } from "./runner.js";

describe("executeQcProvider", () => {
  it("converts parser exceptions into synthetic failed results", async () => {
    const provider: IQcProvider = {
      name: "test",
      supportedModes: ["local"],
      capabilities: ["diff-review"],
      canReview: () => true,
      buildReviewCommand: (_scope: QcReviewScope) => ({ command: "echo", args: ["ok"] }),
      parse: () => {
        throw new Error("bad parse");
      },
      importMetrics: () => {
        throw new Error("unused");
      },
    };

    const execFileImpl = (
      _file: string,
      _args: readonly string[],
      _options: ExecFileOptions,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ): ChildProcess => {
      callback(null, "stdout", "");
      return {} as ChildProcess;
    };

    const result = await executeQcProvider(
      provider,
      { clusterId: "POL-1", runId: "run-1", branch: "main" },
      {
        repoRoot: process.cwd(),
        runId: "run-1",
        clusterId: "POL-1",
        execFileImpl: execFileImpl as unknown as typeof import("node:child_process").execFile,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.policyDecision.summary).toContain("parse failed");
  });
});
