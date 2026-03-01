import { Router } from "express";
import type { Request, Response } from "express";
import { mockLokiResponses } from "../data/loki-logs.js";

const router = Router();

// GET /loki/query_range?query=checkout_payment_failed
// Mimics Grafana Loki HTTP API query_range endpoint.
router.get("/query_range", (req: Request, res: Response) => {
  const { query } = req.query;

  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "query parameter is required" });
    return;
  }

  // Fuzzy match against known log patterns
  const key = Object.keys(mockLokiResponses).find((k) =>
    query.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(query.toLowerCase())
  );

  const result = key ? mockLokiResponses[key] : null;

  if (!result) {
    res.json({
      query,
      time_range: "unknown",
      error_rate_peak: 0,
      peak_time: null,
      total_errors: 0,
      log_lines: [],
    });
    return;
  }

  res.json(result);
});

export default router;
