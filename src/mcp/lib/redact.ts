const SENSITIVE_PATTERN = /secret|token|key|password|credential/i;
const MAX_ARRAY_LENGTH = 50;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    const truncated = value.slice(0, MAX_ARRAY_LENGTH).map(redact);
    return truncated;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_PATTERN.test(k)) {
        result[k] = "[redacted]";
      } else {
        result[k] = redact(v);
      }
    }
    return result;
  }
  return value;
}
