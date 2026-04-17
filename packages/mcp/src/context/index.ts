import type { CacheManager } from "../cache/index.js";
import type { ClientBundle } from "../clients/index.js";
import { CodeMap } from "./code-map.js";
import { CoverageMap } from "./coverage-map.js";
import { Correlator } from "./correlator.js";
import { JourneyGraph } from "./journey-graph.js";
import { SignalMap } from "./signal-map.js";

/**
 * Bundles all context-engine modules. Instantiated once per server.
 */
export interface ContextEngine {
  journeys: JourneyGraph;
  coverage: CoverageMap;
  code: CodeMap;
  signals: SignalMap;
  correlator: Correlator;
}

export function buildContextEngine(clients: ClientBundle, cache: CacheManager): ContextEngine {
  const journeys = new JourneyGraph(clients, cache);
  const coverage = new CoverageMap(clients, cache);
  return {
    journeys,
    coverage,
    code: new CodeMap(clients, cache),
    signals: new SignalMap(clients, cache),
    correlator: new Correlator(journeys, coverage),
  };
}

export { JourneyGraph, CoverageMap, CodeMap, SignalMap, Correlator };
