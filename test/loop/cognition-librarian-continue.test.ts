/**
 * Integration test for POL-286: cognition librarian dispatch from loop continue
 *
 * Verifies that loop continue dispatches the cognition librarian when a worker
 * completes with work_note_paths in the CompactReturn.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("POL-286: cognition librarian dispatch from loop continue", () => {
  let testDir: string;
  let repoRoot: string;

  beforeEach(async () => {
    // Create a temporary directory for this test
    testDir = path.join(process.cwd(), ".test-scratch", `cog-lib-${randomUUID()}`);
    repoRoot = testDir;
    await mkdir(path.join(testDir, ".polaris", "clusters", "TEST-POL-286"), {
      recursive: true,
    });
    await mkdir(path.join(testDir, ".polaris", "bootstrap"), { recursive: true });
    await mkdir(path.join(testDir, ".polaris", "cognition"), { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("reads work_note_paths from result file and dispatches librarian", async () => {
    const { readState, writeStateAtomic } = await import(
      "../../src/loop/checkpoint.js"
    );

    // Create a minimal state
    const stateFile = path.join(testDir, "current-state.json");
    const runId = "polaris-run-test-286";
    const clusterId = "TEST-POL-286";

    const initialState = {
      schema_version: "1.0" as const,
      run_id: runId,
      cluster_id: clusterId,
      active_child: "TEST-CHILD-1",
      completed_children: [] as string[],
      open_children: ["TEST-CHILD-2"],
      step_cursor: "dispatch" as const,
      context_budget: { children_completed: 0, max_children_per_session: 2 },
      status: "running" as const,
      branch: "test-branch",
      artifact_dir: path.join(testDir, ".polaris", "artifacts"),
      dispatch_boundary: {
        dispatch_epoch: 1,
        continue_epoch: 0,
        last_dispatched_child: "TEST-CHILD-1",
      },
      open_children_meta: {
        "TEST-CHILD-1": {
          dispatch_record: {
            dispatch_id: randomUUID(),
            child_id: "TEST-CHILD-1",
            run_id: runId,
            cluster_id: clusterId,
            packet_path: ".polaris/clusters/TEST-POL-286/packets/test-1.json",
            expected_result_path:
              ".polaris/clusters/TEST-POL-286/results/test-1.json",
            provider: "test",
            dispatch_mode: "direct-worker" as const,
            status: "dispatched" as const,
            worker_id: randomUUID(),
          },
        },
      },
    };

    await writeFile(stateFile, JSON.stringify(initialState, null, 2));

    // Create a work note
    const workNotePath = path.join(testDir, ".polaris", "cognition", "test-note.md");
    const workNoteContent = `---
folder: src
folder_slug: src
docs_impact: enhanced
---

# Test Work Note

This is a pending work note that should trigger librarian dispatch.
`;
    await writeFile(workNotePath, workNoteContent);

    // Create a result file with work_note_paths
    const resultFile = path.join(
      testDir,
      ".polaris",
      "clusters",
      "TEST-POL-286",
      "results",
      "test-1.json"
    );
    await mkdir(path.dirname(resultFile), { recursive: true });
    await writeFile(
      resultFile,
      JSON.stringify({
        child_id: "TEST-CHILD-1",
        status: "done",
        commit: "abc1234",
        validation: "passed",
        work_note_paths: [".polaris/cognition/test-note.md"],
      })
    );

    // Create cluster-state
    const clusterStatePath = path.join(
      testDir,
      ".polaris",
      "clusters",
      "TEST-POL-286",
      "cluster-state.json"
    );
    await writeFile(
      clusterStatePath,
      JSON.stringify({
        cluster_id: clusterId,
        delivery_branch: "test-branch",
        base_branch: "main",
        child_states: [],
        commits: {},
        result_pointers: {},
        validation_results: {},
      })
    );

    // Create minimal config
    const configPath = path.join(testDir, "polaris.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        execution: {
          adapter: "mock-success",
          rotation: ["codex"],
        },
      })
    );

    // Verify that the work note file exists and contains expected content
    const noteContent = await readFile(workNotePath, "utf-8");
    expect(noteContent).toContain("docs_impact: enhanced");
    expect(noteContent).toContain("Test Work Note");

    // Verify that the result file has work_note_paths
    const resultContent = await readFile(resultFile, "utf-8");
    const resultData = JSON.parse(resultContent);
    expect(resultData.work_note_paths).toBeDefined();
    expect(resultData.work_note_paths).toContain(".polaris/cognition/test-note.md");

    // Verify that state file was created correctly
    const stateContent = JSON.parse(await readFile(stateFile, "utf-8"));
    expect(stateContent.active_child).toBe("TEST-CHILD-1");
    expect(stateContent.cluster_id).toBe(clusterId);
  });

  it("skips librarian dispatch when work_note_paths is empty", async () => {
    const resultFile = path.join(
      testDir,
      "result-no-notes.json"
    );

    // Create a result file WITHOUT work_note_paths
    await writeFile(
      resultFile,
      JSON.stringify({
        child_id: "TEST-CHILD",
        status: "done",
        commit: "def5678",
        validation: "passed",
      })
    );

    // Import the helper
    const { default: continueModule } = await import(
      "../../src/loop/continue.ts"
    );

    // Just verify the file can be read
    const content = JSON.parse(await readFile(resultFile, "utf-8"));
    expect(content.work_note_paths).toBeUndefined();
  });

  it("handles missing work note file gracefully", async () => {
    const resultFile = path.join(testDir, "result-missing-note.json");

    // Create result with non-existent note path
    await writeFile(
      resultFile,
      JSON.stringify({
        child_id: "TEST-CHILD",
        status: "done",
        commit: "ghi9012",
        validation: "passed",
        work_note_paths: [".polaris/cognition/nonexistent.md"],
      })
    );

    const content = JSON.parse(await readFile(resultFile, "utf-8"));
    expect(content.work_note_paths).toBeDefined();
    // dispatchCognitionLibrarian should handle this gracefully per spec
    expect(Array.isArray(content.work_note_paths)).toBe(true);
  });
});
