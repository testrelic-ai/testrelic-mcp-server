import { Router } from "express";
import type { Request, Response } from "express";
import { mockFlakinessScores } from "../data/flaky-tests.js";

const router = Router();

// POST /clickhouse/query
// Mimics ClickHouse HTTP interface: receives a query body and returns typed results.
router.post("/query", (req: Request, res: Response) => {
  const { run_id } = req.body;

  if (!run_id) {
    res.status(400).json({ error: "run_id is required in the request body" });
    return;
  }

  const scores = mockFlakinessScores[run_id] ?? [];
  res.json({ data: scores, rows: scores.length });
});

export default router;
