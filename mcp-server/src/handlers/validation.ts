/**
 * Input validation helpers shared across all handler modules.
 */

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing or invalid required parameter: ${key} (expected non-empty string)`);
  }
  return v;
}

export function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || isNaN(v)) {
    throw new Error(`Missing or invalid required parameter: ${key} (expected number)`);
  }
  return v;
}

export function requirePositiveNumber(args: Record<string, unknown>, key: string): number {
  const v = requireNumber(args, key);
  if (v <= 0) {
    throw new Error(`Parameter ${key} must be greater than zero`);
  }
  return v;
}

export function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`Missing or invalid required parameter: ${key} (expected non-empty array)`);
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== "string") {
      throw new Error(`Parameter ${key}[${i}] must be a string`);
    }
  }
  return v as string[];
}

export function optionalString(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`Parameter ${key} must be a string if provided`);
  return v;
}
