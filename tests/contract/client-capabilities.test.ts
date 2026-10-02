import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SamplingBridge } from "../../packages/mcp/src/sampling/bridge.js";
import { Elicitor } from "../../packages/mcp/src/elicit/ask.js";

/**
 * TEAI-375 follow-up — on hosted stage every sampling tool (tr_generate_test,
 * tr_plan_test, tr_generate_assertion, healing, triage) hung ~60s and the
 * caller got a reset HTTP/2 stream instead of a result.
 *
 * The SDK only checks client capabilities when `enforceStrictCapabilities` is
 * set, so `sampling/createMessage` went to a client that never declared
 * sampling, and the server waited the SDK's 60s default for a reply. The
 * load balancer's idle timeout fired first.
 *
 * The SDK test client answers unknown requests with an immediate error, which
 * is why the in-process suites never saw this. These stubs never answer, which
 * is what the hosted server actually experienced.
 */

const NEVER = () => new Promise<never>(() => {});

function stubServer(capabilities: Record<string, unknown> | undefined) {
  const calls = { createMessage: 0, elicitInput: 0 };
  const server = {
    server: {
      getClientCapabilities: () => capabilities,
      createMessage: () => {
        calls.createMessage++;
        return capabilities?.sampling
          ? Promise.resolve({ content: { type: "text", text: "sampled" }, model: "m" })
          : NEVER();
      },
      elicitInput: () => {
        calls.elicitInput++;
        return capabilities?.elicitation ? Promise.resolve({ action: "accept", content: { prd: "x" } }) : NEVER();
      },
    },
  } as unknown as McpServer;
  return { server, calls };
}

/** Resolves to "TIMEOUT" if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms = 1_000): Promise<T | "TIMEOUT"> {
  return Promise.race([p, new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), ms))]);
}

describe("server→client requests respect declared client capabilities", () => {
  it("sampling falls back at once, without sending, when the client did not declare sampling", async () => {
    const { server, calls } = stubServer({});
    const res = await within(new SamplingBridge(server).createMessage("write a test"));

    expect(res).not.toBe("TIMEOUT");
    expect(res).toMatchObject({ fallback: true, text: "" });
    expect(calls.createMessage).toBe(0);
  });

  it("sampling still asks a client that declared it", async () => {
    const { server, calls } = stubServer({ sampling: {} });
    const res = await within(new SamplingBridge(server).createMessage("write a test"));

    expect(res).toMatchObject({ fallback: false, text: "sampled" });
    expect(calls.createMessage).toBe(1);
  });

  it("elicitation reports unsupported at once when the client did not declare it", async () => {
    const { server, calls } = stubServer({ sampling: {} });
    const res = await within(new Elicitor(server).ask({ message: "PRD?", schema: z.object({ prd: z.string() }) }));

    expect(res).toEqual({ kind: "unsupported" });
    expect(calls.elicitInput).toBe(0);
  });

  it("elicitation still asks a client that declared it", async () => {
    const { server, calls } = stubServer({ elicitation: {} });
    const res = await within(new Elicitor(server).ask({ message: "PRD?", schema: z.object({ prd: z.string() }) }));

    expect(res).toEqual({ kind: "accepted", content: { prd: "x" } });
    expect(calls.elicitInput).toBe(1);
  });

  it("treats a client that has not initialised (no capabilities yet) as declaring nothing", async () => {
    const { server } = stubServer(undefined);
    expect(await within(new SamplingBridge(server).createMessage("x"))).toMatchObject({ fallback: true });
    expect(await within(new Elicitor(server).ask({ message: "x", schema: z.object({}) }))).toEqual({ kind: "unsupported" });
  });
});
