import axios from "axios";
import type { JiraTicket } from "../types/index.js";

function base(): string {
  const real = process.env.JIRA_BASE_URL;
  const mock = process.env.MOCK_SERVER_URL ?? "http://localhost:4000";
  return real ? real : `${mock}/jira`;
}

function headers(): Record<string, string> {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (email && token) {
    const encoded = Buffer.from(`${email}:${token}`).toString("base64");
    return { Authorization: `Basic ${encoded}`, "Content-Type": "application/json" };
  }
  return { "Content-Type": "application/json" };
}

export async function findIssuesByLabel(
  label: string
): Promise<{ issues: JiraTicket[]; total: number }> {
  const { data } = await axios.get(`${base()}/issues`, {
    headers: headers(),
    params: { label },
  });
  return data;
}

export async function createIssue(body: {
  summary: string;
  priority: string;
  labels: string[];
  description?: string;
}): Promise<JiraTicket> {
  const { data } = await axios.post(`${base()}/issues`, body, { headers: headers() });
  return data;
}
