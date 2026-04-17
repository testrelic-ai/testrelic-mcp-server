import type { FlakinessQueryResult } from "../types/index.js";
import type { ServiceClient } from "./http.js";

export function clickhouseOps(client: ServiceClient) {
  return {
    queryFlakinessScores(run_id: string): Promise<{ data: FlakinessQueryResult[]; rows: number }> {
      return client.post("/query", { run_id });
    },
  };
}

export type ClickhouseOps = ReturnType<typeof clickhouseOps>;
