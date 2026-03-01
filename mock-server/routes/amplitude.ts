import { Router } from "express";
import type { Request, Response } from "express";
import { mockAmplitudeUserCounts, mockAmplitudeSessions } from "../data/amplitude-sessions.js";

const router = Router();

// GET /amplitude/user-count?run_id=RUN-2847
router.get("/user-count", (req: Request, res: Response) => {
  const { run_id } = req.query;

  if (!run_id || typeof run_id !== "string") {
    res.status(400).json({ error: "run_id query parameter is required" });
    return;
  }

  const result = mockAmplitudeUserCounts[run_id];
  if (!result) {
    res.json({ run_id, affected_users: 0, peak_time: null, error_path: null });
    return;
  }

  res.json(result);
});

// GET /amplitude/sessions?run_id=RUN-2847&limit=50
router.get("/sessions", (req: Request, res: Response) => {
  const { run_id, limit } = req.query;

  if (!run_id || typeof run_id !== "string") {
    res.status(400).json({ error: "run_id query parameter is required" });
    return;
  }

  const sessions = mockAmplitudeSessions[run_id] ?? [];
  const pageSize = Math.min(Number(limit) || 50, 100);
  const page = sessions.slice(0, pageSize);

  res.json({ run_id, sessions: page, total: sessions.length });
});

export default router;
