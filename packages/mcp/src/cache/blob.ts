import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger.js";

/**
 * L4: filesystem blob store. Keys by content SHA256 so duplicate payloads
 * share one file. LRU-evicted by total size on disk.
 */

export interface BlobLayerOptions {
  cacheDir: string;
  maxBytes?: number;
}

export class BlobLayer {
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(opts: BlobLayerOptions) {
    this.dir = join(opts.cacheDir, "blobs");
    this.maxBytes = opts.maxBytes ?? 500 * 1024 * 1024;
    mkdirSync(this.dir, { recursive: true });
  }

  public write(content: string | Buffer): string {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const sha = createHash("sha256").update(buf).digest("hex");
    const p = this.pathFor(sha);
    if (!existsSync(p)) {
      writeFileSync(p, buf);
      this.maybeEvict();
    }
    return sha;
  }

  public read(sha: string): Buffer | null {
    const p = this.pathFor(sha);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  }

  public readText(sha: string): string | null {
    const b = this.read(sha);
    return b ? b.toString("utf-8") : null;
  }

  public has(sha: string): boolean {
    return existsSync(this.pathFor(sha));
  }

  private pathFor(sha: string): string {
    return join(this.dir, sha.slice(0, 2), `${sha}.blob`);
  }

  private maybeEvict(): void {
    try {
      const files: Array<{ path: string; size: number; atime: number }> = [];
      for (const sub of readdirSync(this.dir)) {
        const subDir = join(this.dir, sub);
        try {
          if (!statSync(subDir).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const f of readdirSync(subDir)) {
          const p = join(subDir, f);
          try {
            const st = statSync(p);
            files.push({ path: p, size: st.size, atime: st.atimeMs });
          } catch {
            // skip missing files
          }
        }
      }
      let total = files.reduce((a, f) => a + f.size, 0);
      if (total <= this.maxBytes) return;
      files.sort((a, b) => a.atime - b.atime);
      for (const f of files) {
        if (total <= this.maxBytes * 0.9) break;
        try {
          unlinkSync(f.path);
          total -= f.size;
        } catch {
          // ignore eviction errors
        }
      }
    } catch (err) {
      getLogger().debug({ err }, "blob eviction failed");
    }
  }

  private initDirsSync(): void {
    // Make sure shard directories exist on first use
    for (let i = 0; i < 256; i++) {
      mkdirSync(join(this.dir, i.toString(16).padStart(2, "0")), { recursive: true });
    }
  }

  public ensureShards(): void {
    this.initDirsSync();
  }
}
