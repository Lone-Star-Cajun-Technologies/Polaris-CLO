import { runMapValidate } from "../../map/validate.js";

export function stepMapValidate(repoRoot: string): void {
  const result = runMapValidate(repoRoot, 30);
  if (result.hasError) {
    process.stderr.write(
      "finalize aborted: map validation failed — run polaris map validate for details\n",
    );
    process.exit(1);
  }
}
