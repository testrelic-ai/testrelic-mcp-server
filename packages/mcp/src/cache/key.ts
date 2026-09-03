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

/**
 * The identity prefix carried in PLAINTEXT at the front of every cache key.
 *
 * It has two jobs and needs both:
 *  - it SEPARATES entries, so two identities computing the same tool+input can
 *    never land on one entry;
 *  - it is READABLE, so a redeemer can be checked against the key it presents
 *    without a lookup. `tr_fetch_cached` and the `testrelic://cache/{key}`
 *    resource both accept a caller-supplied key, so separation alone would
 *    rest on keys never travelling; the prefix makes it an actual check.
 *
 * 16 hex of a SHA-256: it namespaces, it does not authenticate, so length is
 * about readability in logs rather than collision resistance.
 */
export function identityPrefix(identity: string): string {
  return createHash("sha256").update(`identity::${identity}`).digest("hex").slice(0, 16);
}

/** Used when no identity is bound — i.e. a single-tenant local server. */
export const ANONYMOUS_IDENTITY = "anon";

/**
 * A cache key, namespaced by the identity that minted it.
 *
 * The identity component is not decoration. Every layer beneath this key (L1
 * memory, L2 SQLite ON DISK, L3 vector, L4 blobs) is shared process-wide and
 * L2 survives restarts — so without identity in the key, the moment two
 * callers hold different credentials one org's cached tool output is served to
 * another. That is harmless only while every session shares one identity,
 * which is precisely the property per-caller identity removes.
 */
export function cacheKey(
  tool: string,
  input: unknown,
  schemaVersion = "v1",
  identity: string = ANONYMOUS_IDENTITY,
): string {
  const payload = `${tool}::${schemaVersion}::${canonicalJSON(input)}`;
  const hash = createHash("sha256").update(payload).digest("hex");
  return `${identityPrefix(identity)}:${hash}`;
}

/** True when `key` was minted by `identity` — so a redemption of somebody
 *  else's key can be refused rather than trusted not to happen. */
export function keyBelongsTo(key: string, identity: string): boolean {
  return key.startsWith(`${identityPrefix(identity)}:`);
}

/**
 * SimHash-style stable fingerprint of a text blob. Used by the 3-state diff reader
 * to detect "unchanged" on re-reads cheaply.
 */
export function simHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
