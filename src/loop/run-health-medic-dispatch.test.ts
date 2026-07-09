import { describe, expect, it } from "vitest";
import { compileTreatmentWorkerPacket } from "../medic/treatment-packets.js";
import type { MedicTreatmentPacket } from "../types/result-packet.js";

function makeTreatment(overrides?: Partial<MedicTreatmentPacket>): MedicTreatmentPacket {
  return {
    packet_id: "tp-run-001-r1-sym-001",
    run_id: "run-001",
    cluster_id: "POL-516",
    round: 1,
    source_symptom_ids: ["sym-001"],
    allowed_scope: ["src/foo.ts"],
    prohibited_scope: [".polaris/**"],
    validation_commands: ["npm run build", "npm test"],
    root_cause_hint: "build failure",
    dispatch_metadata: {
      dispatch_id: "disp-001",
      worker_id: "w-001",
      result_file: "/tmp/result.json",
    },
    status: "pending",
    ...overrides,
  };
}

describe("compileTreatmentWorkerPacket", () => {
  it("produces a normal Foreman WorkerPacket with repair role", () => {
    const packet = compileTreatmentWorkerPacket({
      treatment: makeTreatment(),
      stateFile: "/tmp/state.json",
      telemetryFile: "/tmp/telemetry.jsonl",
      branch: "main",
      maxConcurrentWorkers: 1,
    });

    expect(packet.schema_version).toBe("2.1");
    expect(packet.worker_role).toBe("repair");
    expect(packet.active_child).toBe("tp-run-001-r1-sym-001");
    expect(packet.instructions.allowed_scope).toContain("src/foo.ts");
    expect(packet.instructions.validation_commands).toContain("npm run build");
    expect(packet.result_file_contract.result_file).toBe("/tmp/result.json");
    expect(packet.context?.branch).toBe("main");
    expect(packet.context?.repair_round).toBe(1);
  });
});
