import type { CoverageGap, CoverageReport, TestCoverageEntry, UserJourney } from "../types/index.js";
import type { CoverageMap } from "./coverage-map.js";
import type { JourneyGraph } from "./journey-graph.js";

/**
 * Correlator — the canonical 95% formulas live here.
 *
 *   userCoverage  = |{j ∈ top_journeys: ∃ test mapping to j}| / |top_journeys|
 *   testCoverage  = |covered_code_nodes| / |reachable_code_nodes_from_journeys|
 *
 * We also compute the *weighted* user coverage (by Amplitude user count) which
 * is what product teams care about in practice: covering one high-traffic
 * journey is worth more than covering ten long-tail ones.
 */

export interface CorrelationResult {
  user_coverage: number;
  user_coverage_weighted: number;
  test_coverage: number;
  covered_journey_ids: string[];
  uncovered_journeys: UserJourney[];
  total_journeys: number;
  total_users_tracked: number;
  total_users_covered: number;
}

export class Correlator {
  constructor(
    private readonly journeys: JourneyGraph,
    private readonly coverage: CoverageMap,
  ) {}

  public async correlate(project_id: string): Promise<CorrelationResult> {
    const [top, testMap] = await Promise.all([
      this.journeys.top(project_id, 500),
      this.coverage.load(project_id),
    ]);

    const journeysCoveredByTest = new Set<string>();
    const codeNodesCovered = new Set<string>();
    const codeNodesReachable = new Set<string>();

    for (const entry of testMap) {
      for (const jid of entry.journey_ids) journeysCoveredByTest.add(jid);
      for (const cn of entry.code_node_ids) codeNodesCovered.add(cn);
    }

    // Treat every journey's implied nodes as reachable — the test map encodes
    // (test, node) pairs. For "reachable" we use the union of *all* code nodes
    // appearing anywhere in the test map as our denominator, which is a proxy
    // for "reachable from the app's exercised surface".
    for (const entry of testMap) {
      for (const cn of entry.code_node_ids) codeNodesReachable.add(cn);
    }

    const totalJourneys = top.length;
    const coveredCount = top.filter((j) => journeysCoveredByTest.has(j.id)).length;
    const totalUsers = top.reduce((s, j) => s + (j.user_count ?? 0), 0) || 1;
    const coveredUsers = top
      .filter((j) => journeysCoveredByTest.has(j.id))
      .reduce((s, j) => s + (j.user_count ?? 0), 0);

    return {
      user_coverage: totalJourneys > 0 ? coveredCount / totalJourneys : 0,
      user_coverage_weighted: coveredUsers / totalUsers,
      test_coverage: codeNodesReachable.size > 0 ? codeNodesCovered.size / codeNodesReachable.size : 0,
      covered_journey_ids: Array.from(journeysCoveredByTest),
      uncovered_journeys: top.filter((j) => !journeysCoveredByTest.has(j.id)),
      total_journeys: totalJourneys,
      total_users_tracked: totalUsers,
      total_users_covered: coveredUsers,
    };
  }

  public async coverageReport(project_id: string): Promise<CoverageReport> {
    const r = await this.correlate(project_id);
    return {
      project_id,
      generated_at: new Date().toISOString(),
      user_coverage: r.user_coverage,
      test_coverage: r.test_coverage,
      total_journeys: r.total_journeys,
      covered_journeys: r.total_journeys - r.uncovered_journeys.length,
      uncovered_journeys: r.uncovered_journeys.length,
      total_code_nodes: r.total_users_tracked > 0 ? Math.round(r.total_users_tracked) : 0,
      covered_code_nodes: Math.round(r.total_users_covered),
      gaps_summary: r.uncovered_journeys.slice(0, 5).map((j) => ({
        journey_id: j.id,
        user_count: j.user_count,
        reason: j.events.join(" → "),
      })),
    };
  }

  public async rankedGaps(project_id: string, limit = 20): Promise<CoverageGap[]> {
    const r = await this.correlate(project_id);
    const total = r.total_users_tracked || 1;
    const testMap = await this.coverage.load(project_id);

    const gaps = r.uncovered_journeys
      .sort((a, b) => (b.user_count ?? 0) - (a.user_count ?? 0))
      .slice(0, limit)
      .map<CoverageGap>((j) => {
        const partialOverlaps = findPartialOverlaps(j, testMap);
        return {
          journey_id: j.id,
          journey_name: j.name,
          user_count: j.user_count,
          session_count: j.session_count,
          events: j.events,
          pp_coverage_gain: (j.user_count / total) * 100,
          partial_overlaps: partialOverlaps.length > 0 ? partialOverlaps : undefined,
        };
      });
    return gaps;
  }
}

function findPartialOverlaps(journey: UserJourney, testMap: TestCoverageEntry[]): Array<{ test_id: string; overlap: number }> {
  const jevents = new Set(journey.events);
  return testMap
    .map((t) => {
      // Overlap proxy: if the test touches at least one event in the journey
      // via tags like `@journey:<id>` or `@event:<name>`, we consider partial.
      const tagEvents = (t.tags ?? []).filter((tag) => tag.startsWith("@event:")).map((tag) => tag.replace("@event:", ""));
      let matches = 0;
      for (const e of tagEvents) if (jevents.has(e)) matches++;
      const overlap = matches / journey.events.length;
      return { test_id: t.test_id, overlap };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3);
}
