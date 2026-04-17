import type { ResolvedConfig } from "../config.js";
import { buildCloudClient, type ServiceClient } from "./http.js";
import {
  cloudOps,
  legacyAmplitudeAdapter,
  legacyClickhouseAdapter,
  legacyJiraAdapter,
  legacyLokiAdapter,
  legacyTestRelicAdapter,
  type CloudOps,
} from "./cloud.js";
import type { AmplitudeOps } from "./amplitude.js";
import type { ClickhouseOps } from "./clickhouse.js";
import type { JiraOps } from "./jira.js";
import type { LokiOps } from "./loki.js";
import type { TestRelicOps } from "./testrelic.js";

/**
 * v2 ClientBundle: one authenticated cloud client + legacy adapter shims for
 * the per-upstream operation surfaces. Tools should prefer `cloud` directly
 * for new code; the shims keep the existing tool implementations working
 * while they migrate.
 */
export interface ClientBundle {
  /** The canonical cloud client. All new tools should use this. */
  cloud: CloudOps;
  /** Legacy adapters — delegate to `cloud` under the hood. */
  testrelic: TestRelicOps;
  amplitude: AmplitudeOps;
  loki: LokiOps;
  jira: JiraOps;
  clickhouse: ClickhouseOps;
  _raw: {
    /** The single underlying HTTP client. */
    cloud: ServiceClient;
    /** Aliases so tr_health can report per-subsystem circuit states. */
    testrelic: ServiceClient;
    amplitude: ServiceClient;
    loki: ServiceClient;
    jira: ServiceClient;
    clickhouse: ServiceClient;
  };
}

export function buildClients(config: ResolvedConfig): ClientBundle {
  const ctx = { config };
  const cloudClient = buildCloudClient(ctx);
  const cloud = cloudOps(cloudClient);
  return {
    cloud,
    testrelic: legacyTestRelicAdapter(cloud) as unknown as TestRelicOps,
    amplitude: legacyAmplitudeAdapter(cloud) as unknown as AmplitudeOps,
    loki: legacyLokiAdapter(cloud) as unknown as LokiOps,
    jira: legacyJiraAdapter(cloud) as unknown as JiraOps,
    clickhouse: legacyClickhouseAdapter(cloud) as unknown as ClickhouseOps,
    _raw: {
      cloud: cloudClient,
      testrelic: cloudClient,
      amplitude: cloudClient,
      loki: cloudClient,
      jira: cloudClient,
      clickhouse: cloudClient,
    },
  };
}

export type { ServiceClient } from "./http.js";
export type { CloudOps } from "./cloud.js";
