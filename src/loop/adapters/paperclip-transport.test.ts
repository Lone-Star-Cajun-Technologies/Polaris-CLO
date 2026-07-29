import * as http from "node:http";
import { describe, it, expect } from "vitest";
import type { BootstrapPacket } from "./types.js";
import { mapBootstrapPacketToPaperclipIssue, resolveAssigneeForRole, PaperclipAdapter, paperclipRequest } from "./paperclip.js";

interface MockServer {
  url: string;
  stop: () => Promise<void>;
}

function setupMockServer(
  store: Map<string, Record<string, string>>,
  opts: { token?: string; terminalStatus?: string; evidence?: Record<string, unknown> } = { terminalStatus: "done" },
): Promise<MockServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const auth = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : "";
      if (opts.token && auth !== `Bearer ${opts.token}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/companies/company-1/issues") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const payload = JSON.parse(body);
          const existing = store.get(payload.idempotencyKey as string);
          if (existing) {
            res.writeHead(200);
            res.end(JSON.stringify(existing));
            return;
          }
          const now = new Date().toISOString();
          const issue: Record<string, string> = {
            id: `issue-${Math.random().toString(36).slice(2, 8)}`,
            companyId: "company-1",
            title: typeof payload.title === "string" ? payload.title : "untitled",
            status: typeof payload.status === "string" ? payload.status : "todo",
            workMode: typeof payload.workMode === "string" ? payload.workMode : "standard",
            priority: typeof payload.priority === "string" ? payload.priority : "medium",
            assigneeAgentId: typeof payload.assigneeAgentId === "string" ? payload.assigneeAgentId : "unknown",
            idempotencyKey: payload.idempotencyKey,
            createdAt: now,
            updatedAt: now,
          };
          store.set(issue.idempotencyKey as string, issue);
          res.writeHead(201);
          res.end(JSON.stringify(issue));
        });
        return;
      }

      const issueMatch = req.url?.match(/^\/api\/companies\/[^/]+\/issues\/([^/]+)$/);
      if (issueMatch && req.method === "GET") {
        const issue = [...store.values()].find((v) => v.id === issueMatch[1]);
        if (!issue) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }
        const terminalStatus = opts.terminalStatus ?? "done";
        res.writeHead(200);
        res.end(
          JSON.stringify({
            ...issue,
            ...opts.evidence,
            status: terminalStatus,
            // A resolved handoff by default so transport/mapper tests that expect
            // a successful dispatch aren't blocked by the disposition gate — that
            // gate has its own dedicated coverage in paperclip.test.ts.
            ...(terminalStatus === "done"
              ? {
                  successfulRunHandoff: {
                    state: "resolved",
                    required: true,
                    hasLiveContinuation: false,
                    sourceRunId: null,
                    correctiveRunId: null,
                    assigneeAgentId: issue.assigneeAgentId ?? null,
                    detectedProgressSummary: "Transport test completion",
                    createdAt: new Date().toISOString(),
                  },
                }
              : {}),
            updatedAt: new Date().toISOString(),
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    });

    const closePromise = new Promise<void>((resolve) => server.close(() => resolve()));
    server.listen(0, () => {
      const address = server.address();
      const url = (address && typeof address === "object" && address.port) ? `http://127.0.0.1:${address.port}` : "";
      resolve({
        url,
        stop: () => closePromise,
      });
    });
  });
}

const basePacket = {
  schema_version: "2.1",
  run_id: "run-1",
  cluster_id: "cluster-1",
  active_child: "child-1",
  state_file: "/tmp/state.json",
  telemetry_file: "/tmp/telemetry.jsonl",
  dispatch_id: "dispatch-1",
  worker_id: "worker-1",
  context: {
    worker_role: "impl",
    execution: {
      paperclip: {
        assigneeAgentId: "agent-1",
        priority: "high",
        runId: "run-1",
      },
    },
    issue_context: {
      title: "Implement bootstrap mapper",
      body: "Map bootstrap packets to Paperclip issues.",
    },
  },
  instructions: {
    primary_goal: "Implement the bootstrap mapper",
    steps: ["Map packet", "Submit payload"],
    allowed_scope: ["src/loop/adapters/paperclip.ts"],
    validation_commands: ["npm run build"],
  },
  return_contract: ["child_id", "status", "commit", "validation", "next_recommended_action"],
  result_file_contract: { result_file: "/tmp/sealed.json" },
} as const as Partial<BootstrapPacket>;

const commonRuntime = (url: string, token = "secret-token") => ({
  baseUrl: url,
  companyId: "company-1",
  assigneeAgentId: "agent-1",
  tokenEnv: "PAPERCLIP_TOKEN",
  runIdEnv: "PAPER_RUN",
  resolvedToken: token,
  pollIntervalMs: 10,
  timeoutMs: 2000,
});

describe("paperclip adapter transport + mapper", () => {
  it("maps exact packet JSON and excludes token/labels", () => {
    const payload = mapBootstrapPacketToPaperclipIssue(basePacket as BootstrapPacket, commonRuntime("http://127.0.0.1:1/"), "dispatch-a");
    expect(payload.title).toContain("[impl]");
    expect(payload.description).toContain("- `impl` → `polaris-run`");
    expect(payload.assigneeAgentId).toBe("agent-1");
    expect(payload.priority).toBe("high");
    expect(payload.idempotencyKey).toMatch(/^polaris:run-1:dispatch-[a-z0-9-]+$/);
    expect((payload as any).labelIds).toBeUndefined();
    expect((payload as any).parentId).toBeUndefined();
    ["secret-token", "PAPERCLIP_TOKEN"].forEach((secret) => expect(JSON.stringify(payload)).not.toContain(secret));
    const packetMatch = payload.description.match(/POLARIS_PACKET_JSON\s*([\s\S]+)\s*```/);
    expect(packetMatch).toBeTruthy();
    const jsonBlock = JSON.parse(packetMatch![1]!.trim());
    expect(jsonBlock.run_id).toBe("run-1");
    expect(jsonBlock.active_child).toBe("child-1");
  });

  it("caps the issue title even when primary_goal is large, without dropping context from the description", () => {
    const bigGoal = "Issue: child-1 — do the large thing\n" + "x".repeat(4000);
    const baseInstructions = (basePacket as BootstrapPacket & { instructions?: Record<string, unknown> })
      .instructions;
    const packetWithBigGoal: Partial<BootstrapPacket> = {
      ...(basePacket as Partial<BootstrapPacket>),
      instructions: {
        ...baseInstructions,
        primary_goal: bigGoal,
      },
    } as Partial<BootstrapPacket>;

    const payload = mapBootstrapPacketToPaperclipIssue(
      packetWithBigGoal as BootstrapPacket,
      commonRuntime("http://127.0.0.1:1/"),
      "dispatch-b",
    );

    // Title stays well under the issues_open_normalized_title_created_idx
    // btree limit (2704 bytes for the whole indexed row).
    expect(payload.title.length).toBeLessThan(250);
    expect(payload.title).toContain("Issue: child-1 — do the large thing");

    // The full primary_goal text is still in the description's "Primary goal"
    // prose section — the agent doesn't lose context.
    expect(payload.description).toContain(bigGoal);

    // But it isn't duplicated a second time inside the JSON dump.
    const packetMatch = payload.description.match(/POLARIS_PACKET_JSON\s*([\s\S]+)\s*```/);
    const jsonBlock = JSON.parse(packetMatch![1]!.trim());
    expect(jsonBlock.instructions.primary_goal).toBeUndefined();
    expect(jsonBlock.instructions.steps).toBeUndefined();
    expect(jsonBlock.instructions.allowed_scope).toBeDefined();
  });

  it("POST uses bearer auth, optional run header, and stable idempotency key", async () => {
    const store = new Map<string, Record<string, string>>();
    let server: MockServer | null = null;
    try {
      server = await setupMockServer(store, { token: "secret-token" });
      const payload = mapBootstrapPacketToPaperclipIssue(basePacket as BootstrapPacket, commonRuntime(server.url), "dispatch-key");
      const { response, status } = await paperclipRequest(commonRuntime(server.url), {
        method: "POST",
        path: "/api/companies/company-1/issues",
        body: payload,
        runIdHeader: "run-1",
        idempotencyKey: "stable-key",
      });
      expect(status).toBe(201);
      expect(response?.headers.get("authorization")).toBeNull();
    } finally {
      await server?.stop();
    }
  });

  it("network ambiguity/no-duplicate with stable idempotency key", async () => {
    const store = new Map<string, Record<string, string>>();
    let server: MockServer | null = null;
    try {
      server = await setupMockServer(store, {
        token: "secret-token",
        terminalStatus: "done",
        evidence: { pullRequest: { url: "https://github.com/example/repo/pull/1" } },
      });
      const adapter = new PaperclipAdapter(commonRuntime(server.url));
      const result = await adapter.dispatch(basePacket as BootstrapPacket, { provider: "paperclip" });
      expect(store.size).toBe(1);
      expect(result.exit_code).toBe(0);
    } finally {
      await server?.stop();
    }
  });

  it("returns exit_code 2 when status is done but no work-product evidence is present", async () => {
    const store = new Map<string, Record<string, string>>();
    let server: MockServer | null = null;
    try {
      server = await setupMockServer(store, { token: "secret-token", terminalStatus: "done" });
      const adapter = new PaperclipAdapter(commonRuntime(server.url));
      const result = await adapter.dispatch(basePacket as BootstrapPacket, { provider: "paperclip" });
      expect(store.size).toBe(1);
      expect(result.exit_code).toBe(2);
      expect(result.failure_category).toBe("worker-failure");
      expect(result.stderr).toContain("no verifiable work-product evidence");
    } finally {
      await server?.stop();
    }
  });

  it("does not require work-product evidence for non-done terminal statuses", async () => {
    const store = new Map<string, Record<string, string>>();
    let server: MockServer | null = null;
    try {
      server = await setupMockServer(store, { token: "secret-token", terminalStatus: "blocked" });
      const adapter = new PaperclipAdapter(commonRuntime(server.url));
      const result = await adapter.dispatch(basePacket as BootstrapPacket, { provider: "paperclip" });
      expect(store.size).toBe(1);
      expect(result.exit_code).toBe(0);
    } finally {
      await server?.stop();
    }
  });

  describe("resolveAssigneeForRole", () => {
    it("returns a direct roleBindings entry", () => {
      const config = { ...commonRuntime("http://127.0.0.1:1/"), roleBindings: { impl: "agent-impl" } };
      expect(resolveAssigneeForRole("impl", config)).toBe("agent-impl");
    });

    it("follows reportsTo chain and returns the manager's binding", () => {
      const config = {
        ...commonRuntime("http://127.0.0.1:1/"),
        roleBindings: { senior: "agent-senior" },
        reportsTo: { junior: "senior" },
      };
      expect(resolveAssigneeForRole("junior", config)).toBe("agent-senior");
    });

    it("falls back to assigneeAgentId when no binding or chain resolves", () => {
      const config = commonRuntime("http://127.0.0.1:1/");
      expect(resolveAssigneeForRole("impl", config)).toBe("agent-1");
    });

    it("breaks cycles and falls back to assigneeAgentId", () => {
      const config = { ...commonRuntime("http://127.0.0.1:1/"), reportsTo: { a: "b", b: "a" } };
      expect(resolveAssigneeForRole("a", config)).toBe("agent-1");
    });
  });
});
