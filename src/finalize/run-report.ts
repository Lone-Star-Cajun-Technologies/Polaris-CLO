import type { LoopState } from "../loop/checkpoint.js";

export interface RunReportData {
  state: LoopState;
  branch: string;
  validationPassed: boolean;
  prUrl?: string;
  artifacts?: string[];
  notes?: string[];
}

export function generateRunReport(data: RunReportData): string {
  const { state, branch, validationPassed, prUrl, artifacts, notes } = data;
  const total = state.completed_children.length + state.open_children.length;
  const completedCount = state.completed_children.length;

  const childRows = state.completed_children
    .map((id) => `| ${id} | — | — | Done |`)
    .concat(state.open_children.map((id) => `| ${id} | — | — | Open |`))
    .join("\n");

  const artifactList =
    artifacts && artifacts.length > 0
      ? artifacts.map((a) => `- ${a}`).join("\n")
      : "- current-state.json\n- run-report.md";

  const notesList =
    notes && notes.length > 0
      ? notes.map((n) => `- ${n}`).join("\n")
      : "_None_";

  const blockerNote = state.blocker
    ? `\n**Blocker:** ${state.blocker.reason} (child: ${state.blocker.child_id})\n`
    : "";

  return `# Run Report: ${state.run_id}

**Status:** ${state.status}
**Branch:** ${branch}
**PR:** ${prUrl ?? "TBD — set at delivery step 9"}
**Children completed:** ${completedCount} of ${total}
**Validation:** ${validationPassed ? "passed" : "failed"}
${blockerNote}
## Children

| ID | Title | Commit | Status |
|---|---|---|---|
${childRows || "_No children recorded_"}

## Artifacts produced

${artifactList}

## Validation summary

${validationPassed ? "Map validate passed. Schema validate passed." : "One or more validations failed — see step output above."}

## Notes

${notesList}
`;
}
