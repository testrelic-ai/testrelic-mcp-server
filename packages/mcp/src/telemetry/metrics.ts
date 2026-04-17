import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logger.js";

/**
 * Appends one JSON line per tool invocation to ${outputDir}/metrics.jsonl.
 *
 * Line shape:
 *   { ts, tool, capability, input_tokens, output_tokens, duration_ms,
 *     cache_hit, cache_layer, error_code? }
 */

export interface MetricRecord {
  ts: string;
  tool: string;
  capability: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  cache_hit: boolean;
  cache_layer?: "L1" | "L2" | "L3" | "L4" | null;
  error_code?: string;
}

class MetricsWriter {
  private stream: WriteStream | null = null;
  private path: string | null = null;

  public init(outputDir: string): void {
    if (this.stream) return;
    try {
      mkdirSync(outputDir, { recursive: true });
      this.path = join(outputDir, "metrics.jsonl");
      this.stream = createWriteStream(this.path, { flags: "a" });
      this.stream.on("error", (err) => {
        getLogger().warn({ err }, "metrics.jsonl write error — disabling metrics");
        this.stream = null;
      });
    } catch (err) {
      getLogger().warn({ err }, "failed to open metrics.jsonl");
    }
  }

  public record(rec: MetricRecord): void {
    if (!this.stream) return;
    try {
      this.stream.write(JSON.stringify(rec) + "\n");
    } catch {
      // best-effort — never throw from telemetry
    }
  }

  public async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => {
      this.stream!.end(() => resolve());
    });
    this.stream = null;
  }

  public getPath(): string | null {
    return this.path;
  }
}

export const metrics = new MetricsWriter();
