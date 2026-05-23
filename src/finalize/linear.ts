import { request } from "node:https";
import type { LoopState } from "../loop/checkpoint.js";

export interface PostCommentOptions {
  issueId: string;
  state: LoopState;
  branch: string;
  prUrl: string;
  validationPassed: boolean;
  apiKey: string;
}

export async function postLinearComment(options: PostCommentOptions): Promise<void> {
  const { issueId, state, branch, prUrl, validationPassed, apiKey } = options;
  const body = [
    `**polaris finalize complete** — run \`${state.run_id}\``,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Branch | \`${branch}\` |`,
    `| PR | ${prUrl} |`,
    `| Children completed | ${state.completed_children.length} |`,
    `| Map validation | ${validationPassed ? "✓ passed" : "✗ failed"} |`,
  ].join("\n");

  const mutation = `
    mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `;

  const payload = JSON.stringify({ query: mutation, variables: { issueId, body } });

  await new Promise<void>((resolve, reject) => {
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
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Linear API returned ${res.statusCode}`));
            return;
          }
          try {
            const body = Buffer.concat(chunks).toString("utf-8");
            const parsed = JSON.parse(body) as { errors?: unknown[]; data?: { commentCreate?: { success?: boolean } } };
            if (parsed.errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
              reject(new Error(`Linear API GraphQL errors: ${JSON.stringify(parsed.errors)}`));
            } else if (parsed.data?.commentCreate?.success === false) {
              reject(new Error(`Linear commentCreate failed: ${JSON.stringify(parsed.data.commentCreate)}`));
            } else {
              resolve();
            }
          } catch (err) {
            reject(new Error(`Failed to parse Linear API response: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
