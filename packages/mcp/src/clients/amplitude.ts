import type { AmplitudeSession, AmplitudeUserCount } from "../types/index.js";
import type { ServiceClient } from "./http.js";

export function amplitudeOps(client: ServiceClient) {
  return {
    getUserCount(run_id: string): Promise<AmplitudeUserCount> {
      return client.get("/user-count", { run_id });
    },
    getSessions(run_id: string, limit = 50): Promise<{
      run_id: string;
      sessions: AmplitudeSession[];
      total: number;
    }> {
      return client.get("/sessions", { run_id, limit });
    },
    /** v2: top-N journey signatures by distinct user count. */
    listTopJourneys(project_id: string, limit = 50): Promise<{
      project_id: string;
      journeys: Array<{
        id: string;
        name: string;
        events: string[];
        user_count: number;
        session_count: number;
        last_seen: string;
      }>;
    }> {
      return client.get("/journeys", { project_id, limit });
    },
  };
}

export type AmplitudeOps = ReturnType<typeof amplitudeOps>;
