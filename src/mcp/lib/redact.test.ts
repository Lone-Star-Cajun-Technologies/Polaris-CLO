/**
 * Unit tests for src/mcp/lib/redact.ts
 *
 * Covers:
 * - strips keys matching sensitive pattern (secret, token, key, password, credential, API_KEY, etc.)
 * - does NOT strip non-sensitive keys
 * - recursively redacts nested objects
 * - truncates arrays > 50 items to 50
 * - returns non-sensitive primitives unchanged
 * - replaces sensitive key values with "[redacted]"
 */

import { describe, it, expect } from "vitest";
import { redact } from "./redact.js";

describe("redact()", () => {
  it("replaces values of sensitive keys with [redacted]", () => {
    const result = redact({ secret: "mysecret", label: "visible" }) as Record<string, unknown>;
    expect(result["secret"]).toBe("[redacted]");
    expect(result["label"]).toBe("visible");
  });

  it("redacts keys matching: token", () => {
    const result = redact({ token: "abc123" }) as Record<string, unknown>;
    expect(result["token"]).toBe("[redacted]");
  });

  it("redacts keys matching: key", () => {
    const result = redact({ key: "somevalue" }) as Record<string, unknown>;
    expect(result["key"]).toBe("[redacted]");
  });

  it("redacts keys matching: password", () => {
    const result = redact({ password: "hunter2" }) as Record<string, unknown>;
    expect(result["password"]).toBe("[redacted]");
  });

  it("redacts keys matching: credential", () => {
    const result = redact({ credential: "credvalue" }) as Record<string, unknown>;
    expect(result["credential"]).toBe("[redacted]");
  });

  it("redacts keys matching: API_KEY (case-insensitive)", () => {
    const result = redact({ API_KEY: "myapikey" }) as Record<string, unknown>;
    expect(result["API_KEY"]).toBe("[redacted]");
  });

  it("redacts keys matching: secretValue (substring match)", () => {
    const result = redact({ secretValue: "hidden" }) as Record<string, unknown>;
    expect(result["secretValue"]).toBe("[redacted]");
  });

  it("redacts keys matching: accessToken (substring match)", () => {
    const result = redact({ accessToken: "tok_abc" }) as Record<string, unknown>;
    expect(result["accessToken"]).toBe("[redacted]");
  });

  it("does NOT redact non-sensitive keys", () => {
    const result = redact({
      name: "Alice",
      status: "active",
      count: 42,
      enabled: true,
    }) as Record<string, unknown>;
    expect(result["name"]).toBe("Alice");
    expect(result["status"]).toBe("active");
    expect(result["count"]).toBe(42);
    expect(result["enabled"]).toBe(true);
  });

  it("recursively redacts nested objects", () => {
    const input = {
      outer: "visible",
      nested: {
        token: "should-be-redacted",
        label: "still-visible",
        deeper: {
          password: "also-redacted",
          info: "public",
        },
      },
    };
    const result = redact(input) as {
      outer: string;
      nested: { token: string; label: string; deeper: { password: string; info: string } };
    };
    expect(result.outer).toBe("visible");
    expect(result.nested.token).toBe("[redacted]");
    expect(result.nested.label).toBe("still-visible");
    expect(result.nested.deeper.password).toBe("[redacted]");
    expect(result.nested.deeper.info).toBe("public");
  });

  it("truncates arrays longer than 50 items to 50 items", () => {
    const bigArray = Array.from({ length: 100 }, (_, i) => i);
    const result = redact(bigArray) as number[];
    expect(result).toHaveLength(50);
    expect(result[0]).toBe(0);
    expect(result[49]).toBe(49);
  });

  it("does not truncate arrays with 50 or fewer items", () => {
    const arr = Array.from({ length: 50 }, (_, i) => i);
    const result = redact(arr) as number[];
    expect(result).toHaveLength(50);
  });

  it("recursively redacts items within arrays", () => {
    const arr = [{ token: "secret-tok" }, { label: "visible" }];
    const result = redact(arr) as Array<Record<string, unknown>>;
    expect(result[0]?.["token"]).toBe("[redacted]");
    expect(result[1]?.["label"]).toBe("visible");
  });

  it("returns primitive numbers unchanged", () => {
    expect(redact(42)).toBe(42);
  });

  it("returns primitive strings unchanged", () => {
    expect(redact("hello")).toBe("hello");
  });

  it("returns booleans unchanged", () => {
    expect(redact(true)).toBe(true);
    expect(redact(false)).toBe(false);
  });

  it("returns null unchanged", () => {
    expect(redact(null)).toBeNull();
  });
});
