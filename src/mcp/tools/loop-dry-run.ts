import { z } from "zod";
import { executeDryRun } from "../../runtime/continuation/dry-run.js";

export const DryRunInputSchema = z.object({
  artifact_dir: z.string().default("bootstrap-run"),
  expected_step_cursor: z.string(),
});

export type DryRunInput = z.infer<typeof DryRunInputSchema>;

export async function handleLoopContinueDryRun(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = DryRunInputSchema.parse(args);
  const result = await executeDryRun(input);
  return result as Record<string, unknown>;
}
