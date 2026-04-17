import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger.js";

/**
 * L3: vector store. Prefers hnswlib-node with BAAI/bge-small-en-v1.5 embeddings
 * (via @xenova/transformers). Falls back to a pure-JS cosine-similarity linear
 * scan with a deterministic hash-based embedding when native deps are missing.
 *
 * The hash-based fallback is enough for the demo / offline-mock path — it
 * returns stable neighbors for identical or near-identical texts, which keeps
 * tests deterministic without shipping a 30MB ONNX model.
 */

export interface VectorRecord {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  score: number;
  text: string;
  meta?: Record<string, unknown>;
}

interface Embedder {
  embed(text: string): Promise<Float32Array>;
  dimensions: number;
}

interface HnswIndexLike {
  initIndex(max: number): void;
  readIndexSync(path: string): void;
  writeIndexSync(path: string): void;
  addPoint(point: number[] | Float32Array, id: number): void;
  searchKnn(point: number[] | Float32Array, k: number): { neighbors: number[]; distances: number[] };
  resizeIndex(newMaxElements: number): void;
  getMaxElements(): number;
  getCurrentCount(): number;
  markDelete(id: number): void;
}

class HashEmbedder implements Embedder {
  public readonly dimensions = 128;

  public async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const t of tokens) {
      const h = cheapHash(t);
      const idx = h % this.dimensions;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += (v[i] ?? 0) * (v[i] ?? 0);
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
    return v;
  }
}

function cheapHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

class TransformersEmbedder implements Embedder {
  public readonly dimensions = 384;
  private pipeline: ((text: string | string[], opts: unknown) => Promise<{ data: Float32Array }>) | null = null;

  public async init(): Promise<void> {
    try {
      const mod = await import("@xenova/transformers").catch(() => null);
      if (!mod) throw new Error("module missing");
      const { pipeline } = mod as { pipeline: (task: string, model: string, opts?: unknown) => Promise<(input: string | string[], opts: unknown) => Promise<{ data: Float32Array }>> };
      this.pipeline = (await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { quantized: true })) as unknown as typeof this.pipeline;
    } catch {
      // Leave pipeline null; caller will fall back.
      this.pipeline = null;
    }
  }

  public async embed(text: string): Promise<Float32Array> {
    if (!this.pipeline) throw new Error("transformers pipeline unavailable");
    const result = await this.pipeline(text, { pooling: "mean", normalize: true });
    return result.data;
  }
}

export class VectorStore {
  private embedder: Embedder = new HashEmbedder();
  private usingHnsw = false;
  private hnsw: HnswIndexLike | null = null;
  private readonly records = new Map<number, VectorRecord>();
  private nextId = 0;
  private dirty = false;

  constructor(private readonly opts: { cacheDir: string; maxElements?: number; collection?: string }) {}

  private indexPath(): string {
    const col = this.opts.collection ?? "default";
    return join(this.opts.cacheDir, "vector", `${col}.bin`);
  }

  private metaPath(): string {
    const col = this.opts.collection ?? "default";
    return join(this.opts.cacheDir, "vector", `${col}.meta.json`);
  }

  public async init(): Promise<void> {
    const dir = join(this.opts.cacheDir, "vector");
    mkdirSync(dir, { recursive: true });

    const transformers = new TransformersEmbedder();
    await transformers.init();
    if ((transformers as unknown as { pipeline: unknown }).pipeline) {
      this.embedder = transformers;
    }

    const hnswMod = await import("hnswlib-node").catch(() => null);
    if (hnswMod) {
      try {
        const { HierarchicalNSW } = hnswMod as unknown as {
          HierarchicalNSW: new (space: string, dim: number) => HnswIndexLike;
        };
        this.hnsw = new HierarchicalNSW("cosine", this.embedder.dimensions);
        if (existsSync(this.indexPath())) {
          this.hnsw.readIndexSync(this.indexPath());
          const meta = JSON.parse(readFileSync(this.metaPath(), "utf-8")) as {
            records: Array<[number, VectorRecord]>;
            nextId: number;
          };
          this.records.clear();
          for (const [id, rec] of meta.records) this.records.set(id, rec);
          this.nextId = meta.nextId;
        } else {
          this.hnsw.initIndex(this.opts.maxElements ?? 10_000);
        }
        this.usingHnsw = true;
      } catch (err) {
        getLogger().warn({ err }, "hnswlib init failed; using linear scan fallback");
        this.usingHnsw = false;
      }
    } else {
      getLogger().debug("hnswlib-node not installed; using linear scan fallback");
    }
  }

  public async upsert(rec: VectorRecord): Promise<void> {
    const vec = await this.embedder.embed(rec.text);
    const id = this.nextId++;
    this.records.set(id, rec);
    if (this.usingHnsw && this.hnsw) {
      if (this.hnsw.getCurrentCount() + 1 > this.hnsw.getMaxElements()) {
        this.hnsw.resizeIndex(this.hnsw.getMaxElements() * 2);
      }
      this.hnsw.addPoint(vec, id);
    } else {
      (rec as VectorRecord & { _vec?: Float32Array })._vec = vec;
    }
    this.dirty = true;
  }

  public async search(query: string, k = 5): Promise<SearchResult[]> {
    const qvec = await this.embedder.embed(query);
    if (this.usingHnsw && this.hnsw && this.hnsw.getCurrentCount() > 0) {
      const neigh = this.hnsw.searchKnn(qvec, Math.min(k, this.hnsw.getCurrentCount()));
      return neigh.neighbors.map((id, i) => {
        const rec = this.records.get(id);
        return {
          id: rec?.id ?? String(id),
          score: 1 - (neigh.distances[i] ?? 0),
          text: rec?.text ?? "",
          meta: rec?.meta,
        };
      });
    }
    // Linear-scan fallback.
    const results: SearchResult[] = [];
    for (const rec of this.records.values()) {
      const v = (rec as VectorRecord & { _vec?: Float32Array })._vec;
      if (!v) continue;
      results.push({ id: rec.id, score: cosine(qvec, v), text: rec.text, meta: rec.meta });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, k);
  }

  public size(): number {
    return this.records.size;
  }

  public persist(): void {
    if (!this.dirty) return;
    if (this.usingHnsw && this.hnsw) {
      try {
        this.hnsw.writeIndexSync(this.indexPath());
        const meta = {
          records: Array.from(this.records.entries()).map(([id, rec]) => {
            const { _vec, ...clean } = rec as VectorRecord & { _vec?: Float32Array };
            void _vec;
            return [id, clean] as const;
          }),
          nextId: this.nextId,
        };
        writeFileSync(this.metaPath(), JSON.stringify(meta));
      } catch (err) {
        getLogger().warn({ err }, "vector store persist failed");
      }
    }
    this.dirty = false;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
