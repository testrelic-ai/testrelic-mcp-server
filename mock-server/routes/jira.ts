import { Router } from "express";
import type { Request, Response } from "express";
import { getTickets, findTicketsByLabel, createTicket } from "../data/jira-tickets.js";

const router = Router();

// GET /jira/issues?label=RUN-2847
router.get("/issues", (req: Request, res: Response) => {
  const { label } = req.query;

  if (label && typeof label === "string") {
    const matches = findTicketsByLabel(label);
    res.json({ issues: matches, total: matches.length });
    return;
  }

  const all = getTickets();
  res.json({ issues: all, total: all.length });
});

// GET /jira/issues/:key
router.get("/issues/:key", (req: Request, res: Response) => {
  const ticket = getTickets().find((t) => t.key === req.params.key);
  if (!ticket) {
    res.status(404).json({ error: `Jira issue ${req.params.key} not found` });
    return;
  }
  res.json(ticket);
});

// POST /jira/issues
router.post("/issues", (req: Request, res: Response) => {
  const { summary, priority, labels, description } = req.body;

  if (!summary || !priority) {
    res.status(400).json({ error: "summary and priority are required" });
    return;
  }

  const ticket = createTicket({
    summary,
    priority,
    labels: labels ?? [],
    description,
  });

  res.status(201).json(ticket);
});

export default router;
