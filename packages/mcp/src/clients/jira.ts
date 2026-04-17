import type { JiraTicket } from "../types/index.js";
import type { ServiceClient } from "./http.js";

export function jiraOps(client: ServiceClient) {
  return {
    findIssuesByLabel(label: string): Promise<{ issues: JiraTicket[]; total: number }> {
      return client.get("/issues", { label });
    },
    createIssue(body: {
      summary: string;
      priority: string;
      labels: string[];
      description?: string;
    }): Promise<JiraTicket> {
      return client.post("/issues", body);
    },
  };
}

export type JiraOps = ReturnType<typeof jiraOps>;
