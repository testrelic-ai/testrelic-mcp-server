import { createHash } from "node:crypto";

/**
 * Stable cache key derivation.
 *
 * Shape: sha256(tool + "::" + schemaVersion + "::" + canonicalJSON(input))
 *
 * Canonicalization ensures `{a:1,b:2}` and `{b:2,a:1}` yield the same key.
 */

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

export function cacheKey(tool: string, input: unknown, schemaVersion = "v1"): string {
  const payload = `${tool}::${schemaVersion}::${canonicalJSON(input)}`;
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * SimHash-style stable fingerprint of a text blob. Used by the 3-state diff reader
 * to detect "unchanged" on re-reads cheaply.
 */
export function simHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
