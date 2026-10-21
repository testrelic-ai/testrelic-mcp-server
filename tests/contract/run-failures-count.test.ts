import { describe, it, expect } from "vitest";
import { cloudOps, legacyTestRelicAdapter } from "../../packages/mcp/src/clients/cloud.js";
import type { ServiceClient } from "../../packages/mcp/src/clients/http.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import type { ToolContext, ToolDefinition } from "../../packages/mcp/src/registry/index.js";

/**
 * TEAI-381: tr_diagnose_run printed "Failures (N)" next to the run's own
 * "N failed", and the two numbers did not match.
 *
 * The failures were built from `GET /runs/:id/timeline`. That endpoint returns
 * STEPS, capped at 1000 rows, and every row carries the test status of its own
 * attempt. Counting tests with any failed step row went wrong three ways:
 *   - a test that failed and then passed on retry was counted (the run calls it flaky);
 *   - failures past the 1000-row cap were lost on big runs;
 *   - rows with no test id and no title were counted once per step.
 *
 * The run's per-test list (`GET /repos/:repoId/runs/:runId/tests`) answers the
 * question directly. The platform folds every attempt into one row per test,
 * whose status is the FINAL attempt's, and tallies its own `failed` from those
 * rows. The fixtures below use the platform's real shapes: `TestCaseFromApi`
 * and `TimelineStepResponse` from cloud-platform-app shared/types/run.ts. The
 * list row carries `failureMessage` and no failure object, and has no stack.
 */

function stub(routes: Record<string, unknown>, seen: string[] = []): ServiceClient {
  return {
    get: async (url: string) => {
      const path = url.split("?")[0]!;
      seen.push(path);
      if (!(path in routes)) throw new Error(`no stub for ${path}`);
      const v = routes[path];
      if (v instanceof Error) throw v;
      return v;
    },
    post: async () => {
      throw new Error("no post stub");
    },
  } as unknown as ServiceClient;
}

const adapter = (routes: Record<string, unknown>, seen?: string[]) =>
  legacyTestRelicAdapter(cloudOps(stub(routes, seen)));

/** `GET /runs/:id`: the platform's RunResponse, sent directly. */
function runResponse(summary: { passed: number; failed: number; skipped?: number; flaky?: number }, extra: Record<string, unknown> = {}) {
  return {
    id: "8d1c0f5e-run-uuid",
    runId: "r1",
    repoId: "p1",
    testFramework: "playwright",
    status: "completed",
    outcome: "failed",
    totalTests: summary.passed + summary.failed + (summary.skipped ?? 0) + (summary.flaky ?? 0),
    summary: { skipped: 0, flaky: 0, ...summary },
    duration: 1000,
    startedAt: "2026-10-20T10:00:00.000Z",
    finishedAt: "2026-10-20T10:05:00.000Z",
    branch: "main",
    commit: "abc123",
    ...extra,
  };
}

/** One row of the run-tests list. `attempts` lists each attempt's status, oldest first. */
function listedTest(testId: string, attempts: string[], extra: Record<string, unknown> = {}) {
  const final = attempts[attempts.length - 1]!;
  return {
    testId,
    title: `Suite > ${testId}`,
    suite: "Suite",
    status: final,
    durationMs: 100,
    sessionId: "r1",
    retry: attempts.length - 1,
    retryCount: attempts.length - 1,
    retryStatus: null,
    attempts: attempts.map((status, retry) => ({ retry, status, durationMs: 100 })),
    failureMessage: final === "passed" ? null : `Error: ${testId} broke`,
    ...extra,
  };
}

/** The list envelope. The counts are the platform's tally of these rows. */
function testsResponse(tests: unknown[], counts: { passed: number; failed: number; skipped?: number; flaky?: number }) {
  return {
    tests,
    runId: "r1",
    total: tests.length,
    skipped: 0,
    flaky: 0,
    ...counts,
    branch: "main",
    commit: "abc123",
    commitMessage: null,
    environment: null,
  };
}

/** One timeline row. Its `status` is the status of the test attempt it belongs to. */
function step(testId: string | null, status: string, extra: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-10-20T10:01:00.000Z",
    action: "Click locator('#pay')",
    type: "ui_action",
    phase: null,
    status,
    duration: 5,
    videoOffset: null,
    errorMessage: status === "passed" ? null : `Error: ${testId ?? "step"} broke`,
    stackTrace: null,
    screenshotUrl: null,
    screenshotKey: null,
    testId,
    testTitle: testId ? `Suite > ${testId}` : null,
    specFile: "suite.spec.ts",
    runId: "r1",
    repoId: "p1",
    ...extra,
  };
}

const timeline = (steps: unknown[]) => ({ steps, total: steps.length, runId: "r1" });

describe("getRunFailures counts each test's FINAL result (TEAI-381)", () => {
  it("does not count a test that failed and then passed on retry", async () => {
    const tr = adapter({
      "/runs/r1": runResponse({ passed: 1, failed: 1, flaky: 2 }),
      "/repos/p1/runs/r1/tests": testsResponse(
        [
          listedTest("ok", ["passed"]),
          listedTest("retried", ["failed", "passed"]),
          // Some SDKs stamp the final attempt `flaky` instead.
          { ...listedTest("stamped", ["failed", "passed"]), status: "flaky" },
          listedTest("broken", ["failed", "failed"]),
        ],
        { passed: 1, failed: 1, flaky: 2 },
      ),
      // Every step of a failed ATTEMPT reads "failed", including the first
      // attempt of a test that passed on retry.
      "/runs/r1/timeline": timeline([
        step("retried", "failed"),
        step("retried", "passed"),
        step("stamped", "failed"),
        step("broken", "failed"),
        step("broken", "failed"),
      ]),
    });
    const { failures } = await tr.getRunFailures("r1");
    expect(failures.map((f) => f.test_id)).toEqual(["broken"]);
  });

  /** 4 failed tests (one timed out), 2 passed, 1 flaky, on a run too big for the timeline. */
  function bigRun() {
    return {
      "/runs/r1": runResponse({ passed: 2, failed: 4, flaky: 1 }),
      "/repos/p1/runs/r1/tests": testsResponse(
        [
          listedTest("f1", ["failed"]),
          listedTest("p1", ["passed"]),
          listedTest("f2", ["failed", "failed"]),
          listedTest("flaky", ["failed", "passed"]),
          // OpenObserve keeps the sender's casing: Playwright sends `timedOut`.
          listedTest("f3", ["timedOut"], { failureMessage: "Test timeout of 30000ms exceeded." }),
          listedTest("p2", ["passed"]),
          listedTest("f4", ["failed"]),
        ],
        { passed: 2, failed: 4, flaky: 1 },
      ),
      // The 1000-row cap cut this off after f1, so f2..f4 have no steps. What
      // is left is the flaky test's failed first attempt, plus three steps that
      // carry no test id or title.
      "/runs/r1/timeline": timeline([
        step("f1", "failed"),
        step("f1", "failed"),
        step("flaky", "failed"),
        step(null, "failed", { action: "Click locator('#a')" }),
        step(null, "failed", { action: "Fill locator('#b')" }),
        step(null, "failed", { action: "Expect \"toBeVisible\" locator('#c')" }),
      ]),
    };
  }

  it("returns exactly the run's failed count for a run with N failed tests", async () => {
    const tr = adapter(bigRun());
    const [run, { failures }] = await Promise.all([tr.getRun("r1"), tr.getRunFailures("r1")]);
    expect(run.failed).toBe(4);
    expect(failures).toHaveLength(run.failed);
    expect(failures.map((f) => f.test_id)).toEqual(["f1", "f2", "f3", "f4"]);
    // A timeout's message carries no type prefix; the final status supplies it.
    expect(failures.find((f) => f.test_id === "f3")?.error_type).toBe("TimeoutError");
  });

  it("tr_diagnose_run's 'Failures (N)' header matches the run summary", async () => {
    const def = ALL_TOOLS.find((t) => t.name === "tr_diagnose_run") as ToolDefinition;
    const ctx = {
      clients: {
        testrelic: adapter(bigRun()),
        clickhouse: { queryFlakinessScores: async () => ({ data: [], rows: 0 }) },
      },
    } as unknown as ToolContext;
    const res = await def.handler({ run_id: "r1" }, ctx);
    expect(res.text).toContain("**Run summary:** 4 failed / 1 flaky / 2 passed");
    expect(res.text).toContain("### Failures (4)");
    expect((res.structured as { failures: unknown[] }).failures).toHaveLength(4);
  });

  it("carries each test's message, stack, retries and media into the failure", async () => {
    const ESC = "\u001b";
    const tr = adapter({
      "/runs/r1": runResponse({ passed: 0, failed: 3 }),
      "/repos/p1/runs/r1/tests": testsResponse(
        [
          listedTest("pay", ["timedOut", "timedOut", "timedOut"], {
            title: "Checkout > pays with a valid card",
            suite: "Checkout",
            durationMs: 30142,
            failureMessage: `TimeoutError: ${ESC}[2mTimeout 30000ms exceeded.${ESC}[22m`,
          }),
          // Both Postgres fallbacks send no message: the timeline step supplies it.
          listedTest("cart", ["failed"], { failureMessage: null }),
          // Its steps fell past the timeline cap: the message still comes through.
          listedTest("late", ["failed"], { failureMessage: "Error: expected 3 got 0" }),
        ],
        { passed: 0, failed: 3 },
      ),
      "/runs/r1/timeline": timeline([
        step("pay", "timedout", { stackTrace: "at attempt-0 (checkout.spec.ts:60:1)" }),
        step("pay", "timedout", {
          stackTrace: `${ESC}[31mat checkout.spec.ts:67:5${ESC}[39m`,
          screenshotUrl: "https://s3.example/pay-fail.png",
          videoOffset: 28.5,
        }),
        // A later message-only row must not displace the row that has the stack.
        step("pay", "timedout", { errorMessage: "Test timeout of 30000ms exceeded." }),
        step("cart", "failed", {
          errorMessage: "NetworkError: net::ERR_CONNECTION_RESET",
          stackTrace: "at cart.spec.ts:43:5",
        }),
      ]),
    });
    const { failures } = await tr.getRunFailures("r1");
    const byId = new Map(failures.map((f) => [f.test_id, f]));
    expect(byId.get("pay")).toEqual({
      test_id: "pay",
      test_name: "Checkout > pays with a valid card",
      suite: "Checkout",
      error_type: "TimeoutError",
      error_message: "Timeout 30000ms exceeded.",
      stack_trace: "at checkout.spec.ts:67:5",
      duration_ms: 30142,
      retry_count: 2,
      video_url: "",
      video_timestamp_ms: 28500,
      screenshot_url: "https://s3.example/pay-fail.png",
    });
    expect(byId.get("cart")).toMatchObject({
      error_type: "NetworkError",
      error_message: "net::ERR_CONNECTION_RESET",
      stack_trace: "at cart.spec.ts:43:5",
    });
    expect(byId.get("late")).toMatchObject({
      error_type: "Error",
      error_message: "expected 3 got 0",
      stack_trace: "",
    });
  });
});

describe("getRunFailures falls back to the timeline when there is no per-test list", () => {
  const steps = timeline([
    step("a", "failed", { errorMessage: "AssertionError: boom", stackTrace: "at a.spec.ts:1" }),
    step("b", "passed"),
  ]);

  async function expectTimelineFailures(routes: Record<string, unknown>, seen: string[] = []) {
    const { failures } = await adapter({ "/runs/r1/timeline": steps, ...routes }, seen).getRunFailures("r1");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      test_id: "a",
      error_type: "AssertionError",
      error_message: "boom",
      stack_trace: "at a.spec.ts:1",
    });
  }

  it("uses the timeline when the run carries no repo id, without asking for the list", async () => {
    const seen: string[] = [];
    await expectTimelineFailures({ "/runs/r1": runResponse({ passed: 1, failed: 1 }, { repoId: undefined }) }, seen);
    expect(seen.some((p) => p.startsWith("/repos/"))).toBe(false);
  });

  it("uses the timeline when the run itself cannot be read", async () => {
    await expectTimelineFailures({ "/runs/r1": new Error("cloud returned 404 Not Found") });
  });

  it("uses the timeline when the per-test list errors", async () => {
    await expectTimelineFailures({
      "/runs/r1": runResponse({ passed: 1, failed: 1 }),
      "/repos/p1/runs/r1/tests": new Error("cloud returned 502 Bad Gateway"),
    });
  });

  it("uses the timeline when the list's 200 is not a list (CloudFront's SPA rewrite)", async () => {
    await expectTimelineFailures({
      "/runs/r1": runResponse({ passed: 1, failed: 1 }),
      "/repos/p1/runs/r1/tests": "<!doctype html><html></html>",
    });
  });

  it("uses the timeline when the platform has no per-test rows for the run", async () => {
    await expectTimelineFailures({
      "/runs/r1": runResponse({ passed: 1, failed: 1 }),
      "/repos/p1/runs/r1/tests": testsResponse([], { passed: 0, failed: 0 }),
    });
  });

  it("returns no failures when the list says every test passed", async () => {
    const tr = adapter({
      "/runs/r1": runResponse({ passed: 1, failed: 0, flaky: 1 }),
      "/repos/p1/runs/r1/tests": testsResponse(
        [listedTest("a", ["failed", "passed"]), listedTest("b", ["passed"])],
        { passed: 1, failed: 0, flaky: 1 },
      ),
      "/runs/r1/timeline": steps,
    });
    expect((await tr.getRunFailures("r1")).failures).toEqual([]);
  });
});
