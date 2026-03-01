import axios from "axios";
import type { LokiQueryResponse } from "../types/index.js";

function base(): string {
  const real = process.env.LOKI_BASE_URL;
  const mock = process.env.MOCK_SERVER_URL ?? "http://localhost:4000";
  return real ? real : `${mock}/loki`;
}

function headers(): Record<string, string> {
  const user = process.env.LOKI_USERNAME;
  const pass = process.env.LOKI_PASSWORD;
  if (user && pass) {
    const token = Buffer.from(`${user}:${pass}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  return {};
}

export async function queryRange(
  query: string,
  time_range?: string
): Promise<LokiQueryResponse> {
  const { data } = await axios.get(`${base()}/query_range`, {
    headers: headers(),
    params: { query, time_range },
  });
  return data;
}
