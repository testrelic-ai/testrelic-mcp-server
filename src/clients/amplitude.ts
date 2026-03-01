import axios from "axios";
import type { AmplitudeUserCount, AmplitudeSession } from "../types/index.js";

function base(): string {
  const real = process.env.LOKI_BASE_URL; // unused — kept for symmetry
  const mock = process.env.MOCK_SERVER_URL ?? "http://localhost:4000";
  return `${mock}/amplitude`;
}

function headers(): Record<string, string> {
  const apiKey = process.env.AMPLITUDE_API_KEY;
  const secretKey = process.env.AMPLITUDE_SECRET_KEY;
  if (apiKey && secretKey) {
    const token = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  return {};
}

export async function getUserCount(run_id: string): Promise<AmplitudeUserCount> {
  const { data } = await axios.get(`${base()}/user-count`, {
    headers: headers(),
    params: { run_id },
  });
  return data;
}

export async function getSessions(
  run_id: string,
  limit = 50
): Promise<{ run_id: string; sessions: AmplitudeSession[]; total: number }> {
  const { data } = await axios.get(`${base()}/sessions`, {
    headers: headers(),
    params: { run_id, limit },
  });
  return data;
}
