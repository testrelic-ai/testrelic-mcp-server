import { rmSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger.js";
import type { ResolvedConfig } from "../config.js";
import { BlobLayer } from "./blob.js";
import { DiffReader } from "./diff-reader.js";
import { cacheKey } from "./key.js";
import { LruLayer } from "./lru.js";
import { SqliteLayer } from "./sqlite.js";
import { VectorStore } from "./vector.js";

/**
 * Unified cache facade. Tools talk to this; it in turn decides which tier to
 * consult. For the token-reduction strategy:
 *   1. L1 LRU (ms) — burst repeats
 *   2. L2 SQLite (ms) — warm hits across sessions
 *   3. L3 HNSW vector (ms) — semantic neighbors
 *   4. L4 blob (ms) — large artifacts referenced by `cache_key`
 */

export interface CacheLookup<T> {
  value: T;
  layer: "L1" | "L2" | "L3" | "L4";
}

export interface CacheStats {
  l1Hits: number;
  l1Misses: number;
  l2Hits: number;
  l2Misses: number;
  l3Hits: number;
  l3Misses: number;
  l4Hits: number;
  l4Misses: number;
  lruSize: number;
  vectorSize: number;
}

export class CacheManager {
  public readonly lru = new LruLayer({ max: 2_000, ttlMs: 60_000 });
  public readonly sqlite: SqliteLayer;
  public readonly vector: VectorStore;
  public readonly blob: BlobLayer;
  public readonly diff = new DiffReader();
  public readonly stats: CacheStats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
    l3Hits: 0,
    l3Misses: 0,
    l4Hits: 0,
    l4Misses: 0,
    lruSize: 0,
    vectorSize: 0,
  };

  constructor(private readonly config: ResolvedConfig) {
    this.sqlite = new SqliteLayer({ path: join(config.cacheDir, "store.sqlite") });
    this.vector = new VectorStore({ cacheDir: config.cacheDir });
    this.blob = new BlobLayer({ cacheDir: config.cacheDir });
  }

  public async init(): Promise<void> {
    if (this.config.isolated) {
      // Best-effort wipe. Windows can hold the dir open when concurrent
      // runs share a parent; a failure just means we append, not replace.
      try {
        rmSync(this.config.cacheDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      } catch (err) {
        getLogger().debug({ err }, "isolated cacheDir wipe skipped (likely in use)");
      }
    }
    this.blob.ensureShards();
    await this.sqlite.init();
    await this.vector.init();
  }

  public key(tool: string, input: unknown, schemaVersion = "v1"): string {
    return cacheKey(tool, input, schemaVersion);
  }

  public get<T>(key: string): CacheLookup<T> | undefined {
    const l1 = this.lru.get<T>(key);
    if (l1 !== undefined) {
      this.stats.l1Hits++;
      return { value: l1, layer: "L1" };
    }
    this.stats.l1Misses++;

    const l2 = this.sqlite.get<T>(key);
    if (l2 !== undefined) {
      this.stats.l2Hits++;
      this.lru.set(key, l2);
      return { value: l2, layer: "L2" };
    }
    this.stats.l2Misses++;
    return undefined;
  }

  public set<T>(key: string, value: T, opts?: { ttlSeconds?: number; namespace?: string }): void {
    this.lru.set(key, value);
    this.sqlite.set(key, value, opts);
  }

  public invalidateNamespace(namespace: string): void {
    this.sqlite.invalidateNamespace(namespace);
    this.lru.clear();
  }

  public async close(): Promise<void> {
    this.stats.lruSize = this.lru.size();
    this.stats.vectorSize = this.vector.size();
    if (this.config.saveSession) {
      this.vector.persist();
    }
    this.sqlite.close();
  }

  public snapshot(): CacheStats {
    return {
      ...this.stats,
      lruSize: this.lru.size(),
      vectorSize: this.vector.size(),
    };
  }
}

export { cacheKey, simHash } from "./key.js";
export { LruLayer } from "./lru.js";
export { SqliteLayer } from "./sqlite.js";
export { VectorStore } from "./vector.js";
export { BlobLayer } from "./blob.js";
export { DiffReader, type ReadState } from "./diff-reader.js";
