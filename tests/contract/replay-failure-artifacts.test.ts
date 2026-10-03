import { describe, it, expect } from "vitest";
import { cloudOps, legacyTestRelicAdapter } from "../../packages/mcp/src/clients/cloud.js";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import type { ToolContext, ToolDefinition } from "../../packages/mcp/src/registry/index.js";
import type { ServiceClient } from "../../packages/mcp/src/clients/http.js";
import { rerunCommand } from "../../packages/mcp/src/tools/healing/index.js";

/**
 * Regression (TEAI-377): `tr_replay_failure` crashed on every run that had a
 * failure with "Cannot read properties of undefined (reading 'map')".
 *
 * Root cause: the cloud client read `GET /runs/:id/artifacts` as
 * `{ artifacts: [...] }`, but that endpoint is the console/network LOG feed
 * (`{ consoleLogs, networkRequests, navigations, cursor, hasMore, total }`).
 * The tool took `res.artifacts` (undefined) and mapped over it. The mock server
 * never served the route, so the 404 fell into the tool's catch and mock mode
 * looked healthy. The uploaded files live at `/runs/:id/artifacts/files`
 * (`{ artifacts: [{ id, testId, type, fileName }] }`, no URL) and each one
 * resolves to a presigned link via `/runs/:id/artifacts/:artifactId/url`.
 */

function stubClient(routes: Record<string, unknown>): ServiceClient {
  return {
    get: async (url: string) => {
      const path = url.split("?")[0];
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

function ctxWith(routes: Record<string, unknown>): ToolContext {
  return { clients: { testrelic: legacyTestRelicAdapter(cloudOps(stubClient(routes))) } } as unknown as ToolContext;
}

function tool(name: string): ToolDefinition {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t;
}

/** The platform's real `/runs/:id/artifacts` body: logs, no `artifacts` key. */
const LOG_FEED = { consoleLogs: [], networkRequests: [], navigations: [], cursor: null, hasMore: false, total: 0 };

const TIMELINE = {
  steps: [
    { status: "failed", testId: "t1", testTitle: "Checkout > pays", errorMessage: "expected 200 got 500" },
    { status: "failed", testId: "t2", testTitle: "Search > finds", errorMessage: "stale index" },
  ],
};

const RUN = {
  runId: "r1",
  repoId: "p1",
  testFramework: "playwright",
  status: "completed",
  summary: { passed: 0, failed: 2, skipped: 0, flaky: 0 },
  commit: "abc123",
};

const FILES = {
  artifacts: [
    { id: "a1", testId: "t1", type: "video", fileName: "video.webm" },
    { id: "a2", testId: "t1", type: "trace", fileName: "trace.zip" },
    { id: "a3", testId: "t2", type: "video", fileName: "video.webm" },
  ],
};

const URLS = {
  "/runs/r1/artifacts/a1/url": { url: "https://s3/a1" },
  "/runs/r1/artifacts/a2/url": { url: "https://s3/a2" },
  "/runs/r1/artifacts/a3/url": { url: "https://s3/a3" },
};

describe("tr_replay_failure reads the platform's real artifact endpoints (TEAI-377)", () => {
  it("does not crash when /artifacts is the log feed and the file list is empty", async () => {
    const res = await tool("tr_replay_failure").handler(
      { run_id: "r1" },
      ctxWith({
        "/runs/r1/timeline": TIMELINE,
        "/runs/r1": RUN,
        "/runs/r1/artifacts": LOG_FEED,
        "/runs/r1/artifacts/files": { artifacts: [] },
      }),
    );
    expect(res.text).toContain("Replay plan — r1 / Checkout > pays");
    expect(res.text).toContain("git checkout abc123");
    expect(res.text).toContain("No uploaded artefacts");
  });

  it("lists only the target test's files, with presigned URLs", async () => {
    const res = await tool("tr_replay_failure").handler(
      { run_id: "r1", test_id: "t2" },
      ctxWith({ "/runs/r1/timeline": TIMELINE, "/runs/r1": RUN, "/runs/r1/artifacts/files": FILES, ...URLS }),
    );
    const artifacts = (res.structured as { artifacts: Array<{ kind: string; url: string }> }).artifacts;
    expect(artifacts).toEqual([{ kind: "video", url: "https://s3/a3", note: "video.webm" }]);
    expect(res.text).toContain("Search > finds");
  });

  it("still returns a plan when the file list and the run lookup both fail", async () => {
    const res = await tool("tr_replay_failure").handler(
      { run_id: "r1", test_id: "t1" },
      ctxWith({
        "/runs/r1/timeline": TIMELINE,
        "/runs/r1": new Error("502 upstream"),
        "/runs/r1/artifacts/files": new Error("502 upstream"),
      }),
    );
    expect(res.text).toContain("Replay plan — r1 / Checkout > pays");
    expect(res.text).toContain("no commit sha");
  });
});

describe("cloud getRunArtifacts", () => {
  it("drops a file whose presigned URL can't be minted instead of failing", async () => {
    const cloud = cloudOps(
      stubClient({ "/runs/r1/artifacts/files": FILES, "/runs/r1/artifacts/a1/url": { url: "https://s3/a1" } }),
    );
    const { artifacts } = await cloud.getRunArtifacts("r1", "t1");
    expect(artifacts).toEqual([{ kind: "video", url: "https://s3/a1", note: "video.webm" }]);
  });

  it("treats a body with no artifacts array as no files", async () => {
    const cloud = cloudOps(stubClient({ "/runs/r1/artifacts/files": LOG_FEED }));
    expect((await cloud.getRunArtifacts("r1")).artifacts).toEqual([]);
  });
});

describe("tr_replay_failure re-run command", () => {
  // Both titles are real stage failures whose command came out broken:
  // `pw test -g "Expect "toMatch""` and a full " > " path no runner matches.
  it("regex-escapes and shell-quotes a title containing quotes", () => {
    expect(rerunCommand("playwright", "Expect \"toMatch\"")).toBe("npx playwright test -g 'Expect \"toMatch\"'");
  });

  it("uses the leaf title of a describe path", () => {
    expect(
      rerunCommand("playwright", "discounted checkout > chromium > discounted-checkout.spec.ts > checks out (SAVE10)"),
    ).toBe("npx playwright test -g 'checks out \\(SAVE10\\)'");
  });

  it("closes and reopens the quote around an apostrophe", () => {
    expect(rerunCommand("vitest", "user's cart")).toBe("npx vitest run -t 'user'\\''s cart'");
  });

  it("filters Cypress by spec file, which is all it supports", () => {
    expect(rerunCommand("cypress", "pays", "cypress/e2e/pay.cy.ts")).toBe("npx cypress run --spec 'cypress/e2e/pay.cy.ts'");
  });
});
