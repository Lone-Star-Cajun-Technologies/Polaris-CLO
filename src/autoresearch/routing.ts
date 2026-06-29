/**
 * Autoresearch proposal routing.
 *
 * Routes AutresearchProposal objects to the Polaris development tracker (Linear)
 * as new issues. Proposals are NEVER auto-applied — they are filed for human review.
 *
 * Each filed issue includes:
 *   - gate IDs, fix zone, evidence run IDs, artifact type, confidence
 *   - autoresearch-proposal label (when label ID is resolvable)
 *
 * This module is dev-gated: it must only run inside the Polaris dev context.
 */

import { request } from "node:https";
import type { AutresearchProposal } from "./proposal.js";

// ──────────────────────────────────────────────
// Linear issue creation result
// ──────────────────────────────────────────────

export interface ProposalIssueResult {
  proposal_gate_id: string;
  created: boolean;
  issue_id?: string;
  issue_identifier?: string;
  issue_url?: string;
  error?: string;
}

export interface RouteProposalsResult {
  run_id: string;
  team_id: string;
  filed: ProposalIssueResult[];
  total_proposals: number;
  total_created: number;
  total_errors: number;
}

// ──────────────────────────────────────────────
// Linear GraphQL helpers (minimal — reuse pattern from adapter)
// ──────────────────────────────────────────────

interface LinearCreateIssueResponse {
  issueCreate: {
    success: boolean;
    issue?: {
      id: string;
      identifier: string;
      url: string;
    };
  };
}

interface LinearLabelSearchResponse {
  issueLabels: {
    nodes: Array<{ id: string; name: string }>;
  };
}

interface LinearTeamResponse {
  teams: {
    nodes: Array<{ id: string; name: string }>;
  };
}

async function linearGraphql<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const payload = JSON.stringify({ query, variables });
  const raw = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: "api.linear.app",
        path: "/graphql",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Linear API ${res.statusCode}: ${body}`));
            return;
          }
          resolve(body);
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  const parsed = JSON.parse(raw) as { data?: T; errors?: unknown[] };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(parsed.errors)}`);
  }
  if (!parsed.data) throw new Error("Linear API returned no data.");
  return parsed.data;
}

async function resolveTeamId(apiKey: string, teamKey: string): Promise<string> {
  // teamKey may be a UUID or a display name
  const data = await linearGraphql<LinearTeamResponse>(
    apiKey,
    "query AutresearchTeams { teams(first: 250) { nodes { id name } } }",
    {},
  );
  const match = data.teams.nodes.find(
    (t) => t.id === teamKey || t.name === teamKey || t.name.toLowerCase() === teamKey.toLowerCase(),
  );
  if (!match) throw new Error(`Linear team not found: '${teamKey}'. Available: ${data.teams.nodes.map((t) => t.name).join(", ")}`);
  return match.id;
}

async function resolveAutoresearchLabelId(apiKey: string, teamId: string): Promise<string | undefined> {
  try {
    const data = await linearGraphql<LinearLabelSearchResponse>(
      apiKey,
      `query AutresearchLabel($teamId: String!) {
        issueLabels(filter: { team: { id: { eq: $teamId } }, name: { containsIgnoreCase: "autoresearch-proposal" } }, first: 10) {
          nodes { id name }
        }
      }`,
      { teamId },
    );
    return data.issueLabels.nodes[0]?.id;
  } catch {
    // Label lookup is best-effort — don't fail the whole route if it fails
    return undefined;
  }
}

// ──────────────────────────────────────────────
// Issue body builder
// ──────────────────────────────────────────────

function buildIssueBody(proposal: AutresearchProposal): string {
  return [
    `## Autoresearch Proposal`,
    ``,
    `> This issue was filed automatically by \`polaris autoresearch propose\`. **Do not auto-apply.** Human review is required.`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Gate ID | \`${proposal.gate_id}\` |`,
    `| Artifact type | \`${proposal.artifact_type}\` |`,
    `| Fix zone | \`${proposal.fix_zone}\` |`,
    `| Confidence | ${(proposal.confidence * 100).toFixed(1)}% |`,
    `| Run ID | \`${proposal.run_id}\` |`,
    `| Evidence run IDs | ${proposal.evidence_run_ids.map((id) => `\`${id}\``).join(", ")} |`,
    ``,
    `## Hint`,
    ``,
    proposal.hint,
    ``,
    `## Review checklist`,
    ``,
    `- [ ] Confirm the gate failure is reproducible`,
    `- [ ] Identify the specific artifact to change`,
    `- [ ] Draft the proposed change`,
    `- [ ] Test against a real run`,
    `- [ ] Approve and merge`,
  ].join("\n");
}

// ──────────────────────────────────────────────
// Route proposals
// ──────────────────────────────────────────────

export interface RouteProposalsOptions {
  /** LINEAR_API_KEY — required */
  apiKey: string;
  /** Team name or UUID in Linear where issues should be filed */
  teamKey: string;
  /** Dry-run mode: log what would be created without calling Linear */
  dryRun?: boolean;
}

/**
 * Routes proposals to Linear as new issues for human review.
 * Never auto-applies proposals.
 */
export async function routeProposals(
  proposals: AutresearchProposal[],
  options: RouteProposalsOptions,
): Promise<RouteProposalsResult> {
  const { apiKey, teamKey, dryRun = false } = options;
  const runId = proposals[0]?.run_id ?? "unknown";

  const teamId = await resolveTeamId(apiKey, teamKey);
  const labelId = dryRun ? undefined : await resolveAutoresearchLabelId(apiKey, teamId);

  const filed: ProposalIssueResult[] = [];

  for (const proposal of proposals) {
    const title = `[autoresearch-proposal] ${proposal.artifact_type}: ${proposal.gate_id}`;
    const body = buildIssueBody(proposal);

    if (dryRun) {
      filed.push({
        proposal_gate_id: proposal.gate_id,
        created: false,
        issue_id: "(dry-run)",
        issue_identifier: "(dry-run)",
        issue_url: undefined,
      });
      continue;
    }

    try {
      const data = await linearGraphql<LinearCreateIssueResponse>(
        apiKey,
        `mutation AutresearchPropose($teamId: String!, $title: String!, $body: String!, $labelIds: [String!]) {
          issueCreate(input: {
            teamId: $teamId
            title: $title
            description: $body
            labelIds: $labelIds
          }) {
            success
            issue { id identifier url }
          }
        }`,
        {
          teamId,
          title,
          body,
          labelIds: labelId ? [labelId] : [],
        },
      );

      if (data.issueCreate.success && data.issueCreate.issue) {
        filed.push({
          proposal_gate_id: proposal.gate_id,
          created: true,
          issue_id: data.issueCreate.issue.id,
          issue_identifier: data.issueCreate.issue.identifier,
          issue_url: data.issueCreate.issue.url,
        });
      } else {
        filed.push({
          proposal_gate_id: proposal.gate_id,
          created: false,
          error: "issueCreate returned success=false",
        });
      }
    } catch (err) {
      filed.push({
        proposal_gate_id: proposal.gate_id,
        created: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const totalCreated = filed.filter((r) => r.created).length;
  const totalErrors = filed.filter((r) => !r.created && r.error).length;

  return {
    run_id: runId,
    team_id: teamId,
    filed,
    total_proposals: proposals.length,
    total_created: totalCreated,
    total_errors: totalErrors,
  };
}
