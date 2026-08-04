import { describe, it, expect, afterAll } from "vitest";
import { z } from "zod";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";
import { ToolRegistry, type ToolContext, type ToolDefinition } from "../../packages/mcp/src/registry/index.js";
import { TestRelicMcpError } from "../../packages/mcp/src/errors.js";
import { startInProcessServer } from "../fixtures/server.js";
import type { TestRelicServer } from "../../packages/mcp/src/index.js";

/**
 * TEAI-375 — `tr_generate_test` failed with "Output validation error" even
 * though the caller supplied every required input.
 *
 * Root cause: the tool declares a four-field REQUIRED `outputSchema`
 * (file_path, framework, cache_key, code) but its "soft failure" branches
 * returned `{ text: "<guidance>", structured: {} }`. The MCP SDK validates
 * `structuredContent` against `outputSchema` after the handler returns
 * (mcp.js `validateToolOutput`) and throws `McpError(InvalidParams,
 * "Output validation error: ...")` on a mismatch — so the caller received
 * NOTHING, not even the guidance text the branch was written to deliver.
 *
 * The live trigger is a `plan_cache_key` that no longer resolves: L1 LRU
 * expires after 60s and L2 SQLite is per-instance, so a key minted by
 * `tr_plan_test` misses whenever the follow-up call lands on a different
 * server instance (streamable-HTTP behind >1 ECS task) or after the entry
 * aged out. From the caller's seat the inputs are exactly what
 * `tr_plan_test` told it to send — hence "all required inputs supplied
 * correctly".
 *
 * `validateToolOutput` returns early when `result.isError` is set, so the
 * fix is for these branches to raise a typed `TestRelicMcpError`: the
 * registry converts it to an isError result, validation is skipped, and the
 * guidance actually reaches the client.
 *
 * Same family as TEAI-397 (marketplace-shapes.test.ts): structured output
 * that does not satisfy the tool's own declared schema is a 100% outage for
 * that tool, not a degraded result.
 */

let srv: TestRelicServer | undefined;

async function server(): Promise<TestRelicServer> {
  srv ??= await startInProcessServer({ capabilities: ["core", "creation"] });
  return srv;
}

afterAll(async () => {
  await srv?.stop();
});

function tool(name: string): ToolDefinition {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t;
}

/**
 * Runs the same validation the MCP SDK applies to `structuredContent`
 * before it goes over the wire. Throws exactly where a live client fails.
 */
function parseAgainstOutputSchema(def: ToolDefinition, structured: unknown): unknown {
  if (!def.outputSchema) throw new Error(`${def.name} declares no outputSchema`);
  return z.object(def.outputSchema).parse(structured);
}

const PLAN = {
  goal: "Checkout completes with a saved card",
  framework: "playwright" as const,
  steps: [
    { step: 1, action: "Open the cart", expectation: "Cart shows 1 item" },
    { step: 2, action: "Pay with the saved card", expectation: "Success banner visible" },
  ],
};

describe("tr_generate_test survives its own outputSchema (TEAI-375)", () => {
  it("raises a typed error — not an unvalidatable empty payload — when plan_cache_key misses", async () => {
    const def = tool("tr_generate_test");
    const ctx = (await server()).__ctx as ToolContext;

    // A key that was valid when tr_plan_test minted it, but has since aged
    // out of L1 / is absent from this instance's L2. This is the exact call
    // the caller was told to make.
    const call = def.handler({ project_id: "PROJ-1", plan_cache_key: "tr_plan_test:v1:deadbeef" }, ctx);

    await expect(call).rejects.toBeInstanceOf(TestRelicMcpError);
    await call.catch((err: TestRelicMcpError) => {
      // The guidance the branch was always meant to deliver must survive.
      expect(err.message).toMatch(/plan/i);
      expect(err.code).toBe("NOT_FOUND");
    });
  });

  it("raises a typed error when neither plan nor plan_cache_key is supplied", async () => {
    const def = tool("tr_generate_test");
    const ctx = (await server()).__ctx as ToolContext;

    const call = def.handler({ project_id: "PROJ-1" }, ctx);
    await expect(call).rejects.toBeInstanceOf(TestRelicMcpError);
    await call.catch((err: TestRelicMcpError) => expect(err.code).toBe("INVALID_INPUT"));
  });

  it("returns structured output that parses when an inline plan is supplied", async () => {
    const def = tool("tr_generate_test");
    const ctx = (await server()).__ctx as ToolContext;

    const res = await def.handler({ project_id: "PROJ-1", plan: PLAN, file_name: "teai-375.spec.ts" }, ctx);

    const parsed = parseAgainstOutputSchema(def, res.structured) as {
      file_path: string;
      framework: string;
      cache_key: string;
      code: string;
    };
    expect(parsed.framework).toBe("playwright");
    expect(parsed.file_path).toContain("teai-375.spec.ts");
    expect(parsed.cache_key.length).toBeGreaterThan(0);
    expect(parsed.code).toContain("Checkout completes with a saved card");
  });

  it("round-trips a real tr_plan_test cache_key into tr_generate_test", async () => {
    const ctx = (await server()).__ctx as ToolContext;
    const planner = tool("tr_plan_test");
    const generator = tool("tr_generate_test");

    const planned = await planner.handler({ project_id: "PROJ-1", goal: PLAN.goal, framework: "playwright" }, ctx);
    const { cache_key } = parseAgainstOutputSchema(planner, planned.structured) as { cache_key: string };

    const generated = await generator.handler({ project_id: "PROJ-1", plan_cache_key: cache_key }, ctx);
    parseAgainstOutputSchema(generator, generated.structured);
  });
});

describe("tr_plan_test survives its own outputSchema (TEAI-375)", () => {
  it("raises a typed error when neither goal nor journey_id is supplied", async () => {
    const def = tool("tr_plan_test");
    const ctx = (await server()).__ctx as ToolContext;

    const call = def.handler({ project_id: "PROJ-1" }, ctx);
    await expect(call).rejects.toBeInstanceOf(TestRelicMcpError);
    await call.catch((err: TestRelicMcpError) => expect(err.code).toBe("INVALID_INPUT"));
  });
});

describe("the registry catches output-schema drift before the SDK does", () => {
  /**
   * Registers `def` against a stub McpServer and returns the wrapped handler
   * the SDK would call. Exercises the real `ToolRegistry.register` path.
   */
  async function callThroughRegistry(def: ToolDefinition, input: Record<string, unknown> = {}) {
    let wrapped: ((i: Record<string, unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      server: {
        registerTool: (_n: string, _m: unknown, h: (i: Record<string, unknown>) => Promise<unknown>) => {
          wrapped ??= h;
        },
      },
      config: { capabilities: ["creation"], tokenBudgetPerTool: 4_000, legacyAliases: false },
    } as unknown as ToolContext;

    new ToolRegistry().register(ctx, def);
    if (!wrapped) throw new Error("tool was not registered");
    return (await wrapped(input)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: Record<string, unknown>;
    };
  }

  const brokenTool: ToolDefinition = {
    name: "tr_test_only_broken",
    capability: "creation",
    title: "Deliberately drifted tool",
    description: "Returns structured output that violates its own outputSchema.",
    inputSchema: {},
    outputSchema: { file_path: z.string(), code: z.string() },
    handler: async () => ({ text: "partial answer", structured: {} }),
  };

  it("returns an isError result naming the violation instead of a bare protocol failure", async () => {
    const res = await callThroughRegistry(brokenTool);

    expect(res.isError).toBe(true);
    // The SDK skips validation when isError is set, so this replaces its throw.
    expect(res.content[0]?.text).toContain("tr_test_only_broken");
    expect(res.content[0]?.text).toContain("file_path");
    // The partial text still reaches the caller — previously it was discarded.
    expect(res.content[0]?.text).toContain("partial answer");
    expect((res.structuredContent.error as { code: string }).code).toBe("OUTPUT_SCHEMA_VIOLATION");
  });

  it("end-to-end: a stale plan_cache_key now yields guidance, not Output validation error", async () => {
    // The exact call from the bug report, driven through the same wrapper the
    // SDK invokes. Before the fix this returned `structuredContent: {}` with
    // isError unset, which `validateToolOutput` rejected outright.
    const real = (await server()).__ctx as ToolContext;
    let wrapped: ((i: Record<string, unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      ...real,
      server: {
        registerTool: (_n: string, _m: unknown, h: (i: Record<string, unknown>) => Promise<unknown>) => {
          wrapped ??= h;
        },
      },
    } as unknown as ToolContext;

    new ToolRegistry().register(ctx, tool("tr_generate_test"));
    const res = (await wrapped!({ project_id: "PROJ-1", plan_cache_key: "tr_plan_test:v1:deadbeef" })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: Record<string, unknown>;
    };

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Re-run `tr_plan_test`");
    expect((res.structuredContent.error as { code: string }).code).toBe("NOT_FOUND");
  });

  it("leaves a schema-conformant result untouched", async () => {
    const res = await callThroughRegistry({
      ...brokenTool,
      handler: async () => ({ text: "ok", structured: { file_path: "a.spec.ts", code: "test()" } }),
    });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ file_path: "a.spec.ts", code: "test()" });
  });
});

describe("no creation tool can return structured output its schema rejects", () => {
  // Guards the whole capability, not just the two tools that were broken:
  // an empty `structured` is only legal for a tool whose every declared
  // output field is optional.
  it("every creation tool with an outputSchema tolerates an empty payload or has none", () => {
    for (const def of ALL_TOOLS.filter((t) => t.capability === "creation" && t.outputSchema)) {
      const emptyIsLegal = z.object(def.outputSchema!).safeParse({}).success;
      const source = def.handler.toString();
      const returnsEmptyStructured = /structured:\s*\{\s*\}/.test(source);
      expect(
        !returnsEmptyStructured || emptyIsLegal,
        `${def.name} returns \`structured: {}\` but its outputSchema has required fields — ` +
          `the SDK will reject the whole result with "Output validation error"`,
      ).toBe(true);
    }
  });
});
