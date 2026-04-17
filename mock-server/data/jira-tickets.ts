import type { JiraTicket } from "../../packages/mcp/src/types/index.js";

// Pre-seeded tickets used for deduplication testing.
// RUN-2846 already has ENG-4820 → create_jira_ticket should return existing, not create a new one.
// RUN-2847 has no ticket → create_jira_ticket should create ENG-4821.
let tickets: JiraTicket[] = [
  {
    key: "ENG-4820",
    summary: "[TestRelic] Checkout payment flakiness — RUN-2846",
    status: "In Progress",
    priority: "P2",
    url: "https://yourorg.atlassian.net/browse/ENG-4820",
    labels: ["testrelic", "RUN-2846", "checkout", "flakiness"],
    created_at: "2026-02-28T10:30:00Z",
  },
  {
    key: "ENG-4815",
    summary: "[TestRelic] Search index stale — RUN-2845",
    status: "Done",
    priority: "P3",
    url: "https://yourorg.atlassian.net/browse/ENG-4815",
    labels: ["testrelic", "RUN-2845", "search"],
    created_at: "2026-02-27T19:00:00Z",
  },
  {
    key: "ENG-4800",
    summary: "[TestRelic] Product catalog 503 — RUN-2843",
    status: "Done",
    priority: "P1",
    url: "https://yourorg.atlassian.net/browse/ENG-4800",
    labels: ["testrelic", "RUN-2843", "api", "database"],
    created_at: "2026-02-27T10:30:00Z",
  },
];

let nextKey = 4821;

export function getTickets(): JiraTicket[] {
  return tickets;
}

export function findTicketsByLabel(label: string): JiraTicket[] {
  return tickets.filter((t) => t.labels.includes(label));
}

export function createTicket(data: {
  summary: string;
  priority: string;
  labels: string[];
  description?: string;
}): JiraTicket {
  const key = `ENG-${nextKey++}`;
  const ticket: JiraTicket = {
    key,
    summary: data.summary,
    status: "Open",
    priority: data.priority,
    url: `https://yourorg.atlassian.net/browse/${key}`,
    labels: data.labels,
    created_at: new Date().toISOString(),
  };
  tickets.push(ticket);
  return ticket;
}
