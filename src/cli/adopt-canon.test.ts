import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrichCanonFiles } from "./adopt-canon.js";

describe("enrichCanonFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "adopt-canon-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("injects linked_docs when docs are linked to the route", async () => {
    // Setup dirs
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "smartdocs", "doctrine", "active"), { recursive: true });
    mkdirSync(join(root, ".polaris", "map"), { recursive: true });

    writeFileSync(join(root, "src", "POLARIS.md"), "# POLARIS\n", "utf-8");
    writeFileSync(
      join(root, "src", "SUMMARY.md"),
      "# Summary\n\n<!-- polaris:draft -->\n\nSome content.\n",
      "utf-8",
    );
    writeFileSync(join(root, "smartdocs", "doctrine", "active", "AUTH.md"), "# Auth\n", "utf-8");
    writeFileSync(
      join(root, ".polaris", "map", "index.json"),
      JSON.stringify({
        entries: [
          {
            doc_path: "smartdocs/doctrine/active/AUTH.md",
            route: "src",
            title: "Auth",
          },
        ],
      }),
      "utf-8",
    );

    await enrichCanonFiles(root);

    const result = readFileSync(join(root, "src", "SUMMARY.md"), "utf-8");
    expect(result).toContain("linked_docs:");
    expect(result).toContain("AUTH.md");
  });

  it("skips when no entries match the route", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".polaris", "map"), { recursive: true });

    writeFileSync(join(root, "src", "POLARIS.md"), "# POLARIS\n", "utf-8");
    writeFileSync(
      join(root, "src", "SUMMARY.md"),
      "# Summary\n\n<!-- polaris:draft -->\n\nSome content.\n",
      "utf-8",
    );
    writeFileSync(
      join(root, ".polaris", "map", "index.json"),
      JSON.stringify({ entries: [] }),
      "utf-8",
    );

    await enrichCanonFiles(root);

    const result = readFileSync(join(root, "src", "SUMMARY.md"), "utf-8");
    expect(result).not.toContain("linked_docs:");
  });

  it("escapes double quotes in title and doc_path", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "smartdocs", "doctrine", "active"), { recursive: true });
    mkdirSync(join(root, ".polaris", "map"), { recursive: true });

    writeFileSync(join(root, "src", "POLARIS.md"), "# POLARIS\n", "utf-8");
    writeFileSync(
      join(root, "src", "SUMMARY.md"),
      "# Summary\n\n<!-- polaris:draft -->\n\nSome content.\n",
      "utf-8",
    );
    writeFileSync(join(root, "smartdocs", "doctrine", "active", "AUTH.md"), "# Auth\n", "utf-8");
    writeFileSync(
      join(root, ".polaris", "map", "index.json"),
      JSON.stringify({
        entries: [
          {
            doc_path: "smartdocs/doctrine/active/AUTH.md",
            route: "src",
            title: 'The "Auth" Module',
          },
        ],
      }),
      "utf-8",
    );

    await enrichCanonFiles(root);

    const result = readFileSync(join(root, "src", "SUMMARY.md"), "utf-8");
    expect(result).toContain('title: "The \\"Auth\\" Module"');
    // Ensure no raw unescaped double-quote sequence like `"The "Auth"` appears
    expect(result).not.toMatch(/title: "The "Auth"/);
  });

  it("skips already-promoted SUMMARY.md (no draft marker)", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "smartdocs", "doctrine", "active"), { recursive: true });
    mkdirSync(join(root, ".polaris", "map"), { recursive: true });

    writeFileSync(join(root, "src", "POLARIS.md"), "# POLARIS\n", "utf-8");
    writeFileSync(
      join(root, "src", "SUMMARY.md"),
      "# Summary\n\nSome content without draft marker.\n",
      "utf-8",
    );
    writeFileSync(join(root, "smartdocs", "doctrine", "active", "AUTH.md"), "# Auth\n", "utf-8");
    writeFileSync(
      join(root, ".polaris", "map", "index.json"),
      JSON.stringify({
        entries: [
          {
            doc_path: "smartdocs/doctrine/active/AUTH.md",
            route: "src",
            title: "Auth",
          },
        ],
      }),
      "utf-8",
    );

    await enrichCanonFiles(root);

    const result = readFileSync(join(root, "src", "SUMMARY.md"), "utf-8");
    expect(result).not.toContain("linked_docs:");
  });
});
