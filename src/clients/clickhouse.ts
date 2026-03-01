import axios from "axios";
import type { FlakinessQueryResult } from "../types/index.js";

function base(): string {
  const mock = process.env.MOCK_SERVER_URL ?? "http://localhost:4000";
  return `${mock}/clickhouse`;
}

export async function queryFlakinessScores(
  run_id: string
): Promise<{ data: FlakinessQueryResult[]; rows: number }> {
  const { data } = await axios.post(`${base()}/query`, { run_id });
  return data;
}
