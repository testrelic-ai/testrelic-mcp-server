import { LRUCache } from "lru-cache";

export interface LruEntry<T> {
  value: T;
  storedAt: number;
}

/**
 * L1: in-process LRU. Short TTL, sized by count.
 */
export class LruLayer {
  private cache: LRUCache<string, LruEntry<unknown>>;

  constructor(opts: { max?: number; ttlMs?: number } = {}) {
    this.cache = new LRUCache({
      max: opts.max ?? 1_000,
      ttl: opts.ttlMs ?? 60_000,
    });
  }

  public get<T>(key: string): T | undefined {
    return this.cache.get(key)?.value as T | undefined;
  }

  public set<T>(key: string, value: T): void {
    this.cache.set(key, { value, storedAt: Date.now() });
  }

  public has(key: string): boolean {
    return this.cache.has(key);
  }

  public delete(key: string): boolean {
    return this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}
