import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import type { ToolContext, ToolDefinition } from "../../packages/mcp/src/registry/index.js";

/**
 * `tr_diagnose_run` now DECLARES an outputSchema, so its structured payload is
 * validated by the SDK (`validateToolOutput`) after the handler returns — and a
 * mismatch rejects the WHOLE result: the caller loses the diagnosis text, not
 * just the offending field. That makes the schema a liability unless every exit
 * path satisfies it.
 *
 * Which is exactly the trap this file guards. Before the schema was added the
 * handler had three different structured shapes:
 *
 *   not found  -> { run: null, failures: [] }        // no `flakiness`
 *   all passed -> { run }                            // no arrays at all
 *   failures   -> { run, failures, flakiness }
 *
 * Two of those would have failed the schema the moment it was declared, turning
 * "your run passed" into an OUTPUT_SCHEMA_VIOLATION error. Same family as
 * TEAI-375, where a soft-failure branch returning `{ structured: {} }` against a
 * required schema silently killed the tool.
 *
 * So: parse EVERY branch against the tool's own declared schema, which is the
 * precise check the SDK performs.
 */

const def = ALL_TOOLS.find((t) => t.name === "tr_diagnose_run") as ToolDefinition;
const schema = () => z.object(def.outputSchema as z.ZodRawShape);

/** A ToolContext whose clients return exactly what a branch needs. */
function ctxFor(over: {
  run?: unknown;
  failures?: unknown;
  flakiness?: unknown;
}): ToolContext {
  return {
    clients: {
      testrelic: {
        getRun: async () => {
          if (over.run === undefined) throw new Error("not found");
          return over.run;
        },
        getRunFailures: async () => over.failures ?? { run_id: "r1", failures: [] },
      },
      clickhouse: {
        queryFlakinessScores: async () => over.flakiness ?? { data: [], rows: 0 },
      },
    },
  } as unknown as ToolContext;
}

const RUN = {
  run_id: "r1",
  project_id: "p1",
  framework: "playwright",
  status: "failed",
  total: 5,
  passed: 3,
  failed: 2,
  skipped: 0,
  flaky: 0,
  duration_ms: 1000,
  started_at: "2026-06-29T00:00:00.000Z",
  finished_at: "2026-06-29T00:00:01.000Z",
  branch: "main",
  commit_sha: "abc123",
  triggered_by: "",
};

const FAILURE = {
  test_id: "t1",
  test_name: "Auth > login",
  suite: "auth.spec.ts",
  error_type: "Error",
  error_message: "boom",
  stack_trace: "",
  duration_ms: 42,
  retry_count: 0,
  video_url: "",
  video_timestamp_ms: 0,
  screenshot_url: "",
};

describe("tr_diagnose_run declares an outputSchema and every branch satisfies it", () => {
  it("declares one at all (the gap this file closes)", () => {
    expect(def.outputSchema, "tr_diagnose_run must declare an outputSchema").toBeTruthy();
  });

  it("the FAILURES branch parses", async () => {
    const res = await def.handler(
      { run_id: "r1", include_video: false },
      ctxFor({
        run: RUN,
        failures: { run_id: "r1", failures: [FAILURE] },
        flakiness: {
          data: [
            {
              test_id: "t1",
              test_name: "Auth > login",
              flakiness_score: 0.5,
              p90_duration_ms: 0,
              run_count_7d: 10,
              failure_count_7d: 5,
            },
          ],
          rows: 1,
        },
      }),
    );
    const parsed = schema().safeParse(res.structured);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("the ALL-PASSED branch parses (used to omit both arrays)", async () => {
    const res = await def.handler({ run_id: "r1" }, ctxFor({ run: { ...RUN, status: "passed" } }));
    const parsed = schema().safeParse(res.structured);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(res.structured?.failures).toEqual([]);
    expect(res.structured?.flakiness).toEqual([]);
  });

  it("the NOT-FOUND branch parses (used to omit flakiness, and run is legitimately null)", async () => {
    const res = await def.handler({ run_id: "nope" }, ctxFor({}));
    const parsed = schema().safeParse(res.structured);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(res.structured?.run).toBeNull();
  });

  it("a run missing timestamps upstream still parses (degrades the VALUE, not the result)", async () => {
    // The point of defaulting in toRun/queryFlakinessScores: upstream drift must
    // never become an OUTPUT_SCHEMA_VIOLATION, or a declared schema would make
    // the tool MORE fragile than having none.
    const res = await def.handler(
      { run_id: "r1" },
      ctxFor({ run: { ...RUN, started_at: "", finished_at: "", project_id: "" } }),
    );
    const parsed = schema().safeParse(res.structured);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
