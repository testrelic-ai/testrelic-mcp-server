import type { LokiQueryResponse } from "../types/index.js";
import type { ServiceClient } from "./http.js";

export function lokiOps(client: ServiceClient) {
  return {
    queryRange(query: string, time_range?: string): Promise<LokiQueryResponse> {
      return client.get("/query_range", { query, time_range });
    },
  };
}

export type LokiOps = ReturnType<typeof lokiOps>;
