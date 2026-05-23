import { validateState } from "../../loop/checkpoint.js";

export function stepSchemaValidate(state: unknown): void {
  const errors = validateState(state);
  if (errors.length > 0) {
    process.stderr.write(
      `finalize aborted: current-state.json schema invalid:\n${errors.join("\n")}\n`,
    );
    process.exit(1);
  }
}
