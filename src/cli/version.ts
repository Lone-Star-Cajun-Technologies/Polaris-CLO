import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function getVersion(): string {
  const packageJsonPath = resolve(__dirname, "../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    version: string;
  };
  return packageJson.version;
}
