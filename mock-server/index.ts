import express from "express";
import testrelicRouter from "./routes/testrelic.js";
import clickhouseRouter from "./routes/clickhouse.js";
import amplitudeRouter from "./routes/amplitude.js";
import lokiRouter from "./routes/loki.js";
import jiraRouter from "./routes/jira.js";

const app = express();
const PORT = process.env.MOCK_SERVER_PORT ? Number(process.env.MOCK_SERVER_PORT) : 4000;

app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "testrelic-mock-api", timestamp: new Date().toISOString() });
});

// Service namespaces — each mirrors a real external service's request/response shape
app.use("/testrelic", testrelicRouter);
app.use("/clickhouse", clickhouseRouter);
app.use("/amplitude", amplitudeRouter);
app.use("/loki", lokiRouter);
app.use("/jira", jiraRouter);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Mock API route not found" });
});

app.listen(PORT, () => {
  console.log(`[mock-server] Running on http://localhost:${PORT}`);
  console.log(`[mock-server] Routes: /testrelic  /clickhouse  /amplitude  /loki  /jira`);
});

export default app;
