import type { CacheManager } from "../cache/index.js";
import type { ClientBundle } from "../clients/index.js";
import type { UserJourney } from "../types/index.js";

/**
 * Journey graph — condensed DAG of user flows observed in production.
 *
 * v2: fetched from cloud-platform-app's per-repo navigation endpoint
 * (`GET /api/v1/repos/:repoId/navigation`) which is derived server-side from
 * session analytics + the org's Amplitude integration. The MCP never calls
 * Amplitude directly.
 */

export class JourneyGraph {
  private readonly ns = "journey-graph";

  constructor(
    private readonly clients: ClientBundle,
    private readonly cache: CacheManager,
  ) {}

  public async top(project_id: string, limit = 50): Promise<UserJourney[]> {
    const key = this.cache.key("journey-graph:top", { project_id, limit });
    const hit = this.cache.get<UserJourney[]>(key);
    if (hit) return hit.value;
    const { data } = await this.clients.testrelic.listJourneys(project_id, limit);
    this.cache.set(key, data, { ttlSeconds: 3_600, namespace: this.ns });
    return data;
  }

  public async byId(project_id: string, journey_id: string): Promise<UserJourney | undefined> {
    const all = await this.top(project_id, 500);
    return all.find((j) => j.id === journey_id);
  }

  public async totalUsers(project_id: string): Promise<number> {
    const all = await this.top(project_id, 500);
    return all.reduce((sum, j) => sum + (j.user_count ?? 0), 0);
  }

  public invalidate(): void {
    this.cache.invalidateNamespace(this.ns);
  }
}
