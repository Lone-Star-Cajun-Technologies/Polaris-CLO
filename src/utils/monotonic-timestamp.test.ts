import { describe, expect, it, vi, afterEach } from "vitest";
import { getMonotonicTimestamp } from "./monotonic-timestamp.js";

describe("getMonotonicTimestamp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns ISO timestamps that strictly increase when called in the same millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));

    const first = getMonotonicTimestamp();
    const second = getMonotonicTimestamp();
    const third = getMonotonicTimestamp();

    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    expect(Date.parse(third)).toBeGreaterThan(Date.parse(second));
  });
});
