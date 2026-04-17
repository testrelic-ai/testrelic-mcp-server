import type { CacheManager } from "../cache/index.js";
import type { ClientBundle } from "../clients/index.js";
import type { LokiLogLine } from "../types/index.js";

/**
 * Signal map — last-24h error buckets by route/service, proxied through the
 * cloud platform's Loki integration (`GET /api/v1/integrations/loki/logs`).
 * The MCP never contacts Loki directly; the platform uses the org's stored
 * Loki credentials to run the query and strips them from the response.
 */

export interface SignalBucket {
  service: string;
  error_rate_peak: number;
  peak_time: string;
  total_errors: number;
  log_lines: LokiLogLine[];
  time_range: string;
}

export class SignalMap {
  private readonly ns = "signal-map";

  constructor(
    private readonly clients: ClientBundle,
    private readonly cache: CacheManager,
  ) {}

  public async forPattern(error_pattern: string, time_range?: string): Promise<SignalBucket> {
    const key = this.cache.key("signal-map:pattern", { error_pattern, time_range: time_range ?? "default" });
    const hit = this.cache.get<SignalBucket>(key);
    if (hit) return hit.value;
    const data = await this.clients.loki.queryRange(error_pattern, time_range);
    const bucket: SignalBucket = {
      service: data.log_lines[0]?.service ?? "unknown",
      error_rate_peak: data.error_rate_peak,
      peak_time: data.peak_time,
      total_errors: data.total_errors,
      log_lines: data.log_lines,
      time_range: data.time_range,
    };
    this.cache.set(key, bucket, { ttlSeconds: 300, namespace: this.ns });
    return bucket;
  }

  public invalidate(): void {
    this.cache.invalidateNamespace(this.ns);
  }
}
