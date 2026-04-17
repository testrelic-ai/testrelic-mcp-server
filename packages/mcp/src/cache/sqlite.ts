import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "../logger.js";

/**
 * L2: warm SQLite cache. Uses better-sqlite3 when available.
 * Falls back to an in-memory Map when the native module is missing, so the
 * server still runs in environments without compilation toolchains.
 */

interface SqliteLikeDb {
  prepare(sql: string): SqliteLikeStmt;
  exec(sql: string): void;
  close(): void;
}

interface SqliteLikeStmt {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteLayerOptions {
  path: string;
  /** Default TTL in seconds. Individual writes can override. */
  defaultTtlSeconds?: number;
}

export class SqliteLayer {
  private db: SqliteLikeDb | null = null;
  private fallback = new Map<string, { value: string; expiresAt: number }>();
  private readonly defaultTtlSeconds: number;

  constructor(private readonly opts: SqliteLayerOptions) {
    this.defaultTtlSeconds = opts.defaultTtlSeconds ?? 3_600;
  }

  public async init(): Promise<void> {
    try {
      // Dynamic import — optional dependency. Not typed because it's
      // optional; we wrap with a guard and fall back cleanly.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore optional native dep
      const mod = await import("better-sqlite3").catch(() => null);
      if (!mod || !mod.default) {
        getLogger().warn("better-sqlite3 not available — L2 cache falls back to in-memory map");
        return;
      }
      mkdirSync(dirname(this.opts.path), { recursive: true });
      const Database = mod.default as unknown as new (path: string) => SqliteLikeDb;
      this.db = new Database(this.opts.path);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kv (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          namespace TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_kv_namespace ON kv(namespace);
        CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv(expires_at);
      `);
    } catch (err) {
      getLogger().warn({ err }, "SQLite init failed; using in-memory fallback");
      this.db = null;
    }
  }

  public get<T>(key: string): T | undefined {
    const now = Date.now();
    if (this.db) {
      const row = this.db.prepare("SELECT v, expires_at FROM kv WHERE k = ?").get(key) as
        | { v: string; expires_at: number }
        | undefined;
      if (!row) return undefined;
      if (row.expires_at < now) {
        this.db.prepare("DELETE FROM kv WHERE k = ?").run(key);
        return undefined;
      }
      return JSON.parse(row.v) as T;
    }
    const fb = this.fallback.get(key);
    if (!fb) return undefined;
    if (fb.expiresAt < now) {
      this.fallback.delete(key);
      return undefined;
    }
    return JSON.parse(fb.value) as T;
  }

  public set<T>(key: string, value: T, opts?: { ttlSeconds?: number; namespace?: string }): void {
    const ttl = opts?.ttlSeconds ?? this.defaultTtlSeconds;
    const expiresAt = Date.now() + ttl * 1000;
    const serialized = JSON.stringify(value);
    if (this.db) {
      this.db
        .prepare(
          "INSERT INTO kv (k, v, expires_at, namespace) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at",
        )
        .run(key, serialized, expiresAt, opts?.namespace ?? null);
    } else {
      this.fallback.set(key, { value: serialized, expiresAt });
    }
  }

  public invalidateNamespace(namespace: string): void {
    if (this.db) {
      this.db.prepare("DELETE FROM kv WHERE namespace = ?").run(namespace);
    } else {
      // No namespace tracking in fallback — nuke all.
      this.fallback.clear();
    }
  }

  public clear(): void {
    if (this.db) {
      this.db.exec("DELETE FROM kv");
    } else {
      this.fallback.clear();
    }
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.fallback.clear();
  }
}
