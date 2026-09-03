import { describe, it, expect } from "vitest";
import { cacheKey, keyBelongsTo, identityPrefix, ANONYMOUS_IDENTITY } from "../../packages/mcp/src/cache/key.js";

/**
 * Cross-tenant separation in the cache.
 *
 * Every layer under a cache key is shared process-wide, and L2 is a SQLite
 * file that SURVIVES RESTARTS. The key used to be
 * `sha256(tool::schemaVersion::input)` with no identity in it at all, which is
 * safe only while every session shares one credential — exactly the property
 * per-caller identity removes. Two orgs asking the same question would then
 * have collided on one entry, and `tr_fetch_cached` would redeem any key
 * handed to it with no ownership check whatsoever.
 *
 * These tests are the reason that cannot come back.
 */
describe("cache keys are namespaced by identity", () => {
  const input = { project_id: "repo-1", limit: 10 };

  it("gives two identities DIFFERENT keys for identical input", () => {
    const a = cacheKey("tr_test_map", input, "v1", "org-a-token");
    const b = cacheKey("tr_test_map", input, "v1", "org-b-token");
    expect(a).not.toBe(b);
  });

  it("is still stable for one identity — the cache must actually cache", () => {
    expect(cacheKey("tr_test_map", input, "v1", "org-a")).toBe(
      cacheKey("tr_test_map", input, "v1", "org-a"),
    );
    // Canonicalisation still holds across key order.
    expect(cacheKey("t", { a: 1, b: 2 }, "v1", "org-a")).toBe(
      cacheKey("t", { b: 2, a: 1 }, "v1", "org-a"),
    );
  });

  it("still separates by tool, input and schema version", () => {
    expect(cacheKey("tool-a", input, "v1", "o")).not.toBe(cacheKey("tool-b", input, "v1", "o"));
    expect(cacheKey("t", { x: 1 }, "v1", "o")).not.toBe(cacheKey("t", { x: 2 }, "v1", "o"));
    expect(cacheKey("t", input, "v1", "o")).not.toBe(cacheKey("t", input, "v2", "o"));
  });

  it("carries the identity in PLAINTEXT so ownership is checkable without a lookup", () => {
    const key = cacheKey("tr_test_map", input, "v1", "org-a");
    expect(key.startsWith(`${identityPrefix("org-a")}:`)).toBe(true);
    expect(keyBelongsTo(key, "org-a")).toBe(true);
    // The whole point: a key minted by A is refused for B.
    expect(keyBelongsTo(key, "org-b")).toBe(false);
  });

  it("does NOT put the raw credential in the key", () => {
    // The prefix is a digest. A key travels to the model and into logs, so the
    // token itself must never be recoverable from it.
    const token = `tr_mcp_${"a".repeat(64)}`;
    const key = cacheKey("t", input, "v1", token);
    expect(key).not.toContain(token);
    expect(key).not.toContain("tr_mcp_");
  });

  it("defaults to a single shared identity, so a local server still caches", () => {
    expect(cacheKey("t", input)).toBe(cacheKey("t", input, "v1", ANONYMOUS_IDENTITY));
  });
});
