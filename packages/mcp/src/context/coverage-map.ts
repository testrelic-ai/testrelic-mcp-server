import type { CacheManager } from "../cache/index.js";
import type { ClientBundle } from "../clients/index.js";
import type { TestCoverageEntry } from "../types/index.js";

/**
 * Coverage map — `test_id -> { journey_ids[], code_node_ids[] }`.
 *
 * Built from three sources server-side:
 *   1. Run artefacts (inferred network calls, selectors touched).
 *   2. Static tags on tests (e.g. `@journey:checkout-guest`).
 *   3. AST-extracted API calls (best-effort).
 *
 * This module just caches the platform's `/test-map` response.
 */

export class CoverageMap {
  private readonly ns = "coverage-map";

  constructor(
    private readonly clients: ClientBundle,
    private readonly cache: CacheManager,
  ) {}

  public async load(project_id: string): Promise<TestCoverageEntry[]> {
    const key = this.cache.key("coverage-map:load", { project_id });
    const hit = this.cache.get<TestCoverageEntry[]>(key);
    if (hit) return hit.value;
    const { data } = await this.clients.testrelic.getTestMap(project_id);
    this.cache.set(key, data, { ttlSeconds: 1_800, namespace: this.ns });
    return data;
  }

  public async byTestId(project_id: string, test_id: string): Promise<TestCoverageEntry | undefined> {
    const all = await this.load(project_id);
    return all.find((e) => e.test_id === test_id);
  }

  public async testsCoveringJourney(project_id: string, journey_id: string): Promise<TestCoverageEntry[]> {
    const all = await this.load(project_id);
    return all.filter((e) => e.journey_ids.includes(journey_id));
  }

  public async testsTouchingCodeNode(project_id: string, code_node_id: string): Promise<TestCoverageEntry[]> {
    const all = await this.load(project_id);
    return all.filter((e) => e.code_node_ids.includes(code_node_id));
  }

  public invalidate(): void {
    this.cache.invalidateNamespace(this.ns);
  }
}
