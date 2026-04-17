import { createPatch } from "diff";
import { simHash } from "./key.js";

/**
 * 3-state reader: returns either the full payload, an "unchanged" stub, or a
 * unified diff against the previously returned state. Keyed by caller-supplied
 * resource id.
 *
 * Token savings: 80–95% on repeats of large, mostly-stable payloads
 * (e.g. coverage reports, repo manifests, journey catalogs).
 */

export type ReadState =
  | { state: "full"; content: string; fingerprint: string }
  | { state: "unchanged"; fingerprint: string }
  | { state: "diff"; content: string; fingerprint: string; previousFingerprint: string };

interface CachedSnapshot {
  fingerprint: string;
  content: string;
  ts: number;
}

export class DiffReader {
  private readonly snapshots = new Map<string, CachedSnapshot>();

  public read(resourceId: string, content: string): ReadState {
    const fingerprint = simHash(content);
    const prev = this.snapshots.get(resourceId);

    if (!prev) {
      this.snapshots.set(resourceId, { fingerprint, content, ts: Date.now() });
      return { state: "full", content, fingerprint };
    }

    if (prev.fingerprint === fingerprint) {
      return { state: "unchanged", fingerprint };
    }

    const patch = createPatch(resourceId, prev.content, content, "previous", "current");
    this.snapshots.set(resourceId, { fingerprint, content, ts: Date.now() });
    return {
      state: "diff",
      content: patch,
      fingerprint,
      previousFingerprint: prev.fingerprint,
    };
  }

  public forget(resourceId: string): void {
    this.snapshots.delete(resourceId);
  }

  public clear(): void {
    this.snapshots.clear();
  }

  public size(): number {
    return this.snapshots.size;
  }
}
