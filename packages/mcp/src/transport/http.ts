import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { getLogger } from "../logger.js";
import type { ResolvedConfig } from "../config.js";
import { version } from "../version.js";

/**
 * Streamable HTTP transport. One Express server, two relevant routes:
 *   GET  /healthz — JSON health probe
 *   POST /mcp     — MCP JSON-RPC
 *
 * Session management is by the `Mcp-Session-Id` header per the spec.
 *
 * `McpServer` is a single-connection object — it throws on a second
 * `connect()`. For Streamable HTTP we therefore build a fresh server
 * per session via the `buildServer` factory. Subsequent requests on
 * the same session are routed to the already-connected transport.
 */

/** Format a host + port into a canonical HTTP `Host` header value. */
function toHostHeader(host: string, port: number): string {
  // IPv6 literals must be bracketed in a Host header (`[::1]:3000`).
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${bracketed}:${port}`;
}

/** True for loopback hosts (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/**
 * Build the DNS-rebinding allow-list: the loopback names plus the explicitly
 * configured host, on our port. A browser page that rebinds a DNS name to
 * 127.0.0.1 sends its *own* hostname in the Host header, which will not match
 * any entry here and is rejected by the transport.
 *
 * `publicHosts` extends the list with the hostnames a fronting proxy/CDN
 * forwards in the Host header. Without this, a hosted deployment (CloudFront →
 * nginx `proxy_set_header Host $host` → this server) rejects EVERY real client
 * with 403 "Invalid Host header" — which is exactly what happened to
 * mcp-stage.testrelic.ai when this hardening first shipped: the allow-list
 * only knew the bind address, so the protection took the whole hosted
 * endpoint down rather than protecting it. Public entries are added both bare
 * (proxies at :443/:80 forward `Host: name` with no port) and with our port.
 *
 * Origin is handled differently from Host: it is enforced only for a local
 * loopback server. A hosted deployment returns an EMPTY `allowedOrigins`,
 * which the SDK treats as "do not validate Origin". See the comment at the
 * return site for why an origin allow-list is unimplementable for a hosted
 * MCP endpoint.
 */
export function buildAllowList(
  host: string,
  port: number,
  publicHosts: readonly string[] = [],
): { allowedHosts: string[]; allowedOrigins: string[] } {
  const hosts = new Set<string>([
    toHostHeader("127.0.0.1", port),
    toHostHeader("localhost", port),
    toHostHeader("::1", port),
    toHostHeader(host, port),
  ]);
  // Standard ports may arrive without an explicit `:port` in the Host header.
  if (port === 80 || port === 443) {
    for (const h of [...hosts]) hosts.add(h.replace(/:\d+$/, ""));
  }
  for (const raw of publicHosts) {
    const h = raw.trim().toLowerCase();
    if (!h) continue;
    hosts.add(h);
    hosts.add(toHostHeader(h, port));
  }
  // Origin is a *browser* control and cannot be allow-listed for a hosted
  // endpoint. Real MCP clients send origins we can never enumerate --
  // `https://claude.ai`, `vscode-webview://<random>`, `app://...`, or the
  // literal `null` from an Electron shell -- while this list can only ever
  // contain our own hostnames, because it is derived from them. Enforcing it
  // 403'd every real client with "Invalid Origin header" while a bare curl
  // (which sends no Origin header at all) sailed through, so the endpoint
  // looked healthy from every probe we ran.
  //
  // This is the Origin half of the bug #42/#43 fixed for Host. The SDK skips
  // Origin validation entirely when this list is empty, and still enforces
  // `allowedHosts` -- the control that actually stops DNS rebinding. For a
  // hosted server, authentication rather than Origin is the gate.
  const hosted = publicHosts.some((h) => h.trim() !== "") || !isLoopbackHost(host);
  if (hosted) return { allowedHosts: [...hosts], allowedOrigins: [] };

  // Loopback/local HTTP keeps the Origin allow-list: a malicious web page can
  // reach 127.0.0.1, which is the case this protection was written for.
  const origins = new Set<string>();
  for (const h of hosts) {
    origins.add(`http://${h}`);
    origins.add(`https://${h}`);
  }
  return { allowedHosts: [...hosts], allowedOrigins: [...origins] };
}

export async function startHttp(
  buildServer: () => McpServer,
  config: ResolvedConfig,
): Promise<() => Promise<void>> {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  const port = config.server.port || 3000;
  const host = config.server.host || "127.0.0.1";

  // DNS-rebinding protection. Every session transport enforces this allow-list
  // of Host/Origin values so a malicious web page cannot drive this server via
  // the user's browser.
  const { allowedHosts, allowedOrigins } = buildAllowList(host, port, config.server.publicHosts);
  // Log the Origin policy too. This previously logged only `allowedHosts`, so a
  // deployment that was 403-ing every client on Origin looked identical in the
  // logs to a healthy one.
  getLogger().info(
    {
      allowedHosts,
      originPolicy: allowedOrigins.length === 0 ? "not-enforced (hosted)" : "allow-list (local)",
      allowedOrigins,
    },
    "http transport Host/Origin allow-list",
  );

  if (!isLoopbackHost(host)) {
    getLogger().warn(
      { host, port },
      "http transport is bound to a non-loopback host — the MCP server is reachable off this machine. " +
        "Bind to 127.0.0.1 unless it sits behind an authenticating proxy you trust.",
    );
  }

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, version, transport: "http", capabilities: config.capabilities });
  });

  /**
   * Caller authentication for `/mcp`.
   *
   * Until this existed a hosted deployment ran tool calls for ANYONE who could
   * reach it: the transport read only `mcp-session-id` and never looked at
   * `Authorization`, while every session used the container's own PAT. So an
   * anonymous request off the public internet executed as the owning org.
   * Verified against production 2026-09-01 — an unauthenticated `tools/call`
   * returned the org's repository list.
   *
   * The gate compares against the server's OWN configured token, which makes
   * it a shared secret rather than per-caller identity: every session still
   * acts as the one configured identity, exactly as before. Using the caller's
   * own PAT for upstream calls is the real fix and is deliberately not
   * attempted here — it changes the product's tenancy model and deserves its
   * own change.
   *
   * `/healthz` stays open on purpose: the load balancer probes it and it
   * reveals only a version string.
   */
  const expectedToken = config.cloud.token;
  const requireAuth = config.server.requireAuth;

  if (requireAuth && !expectedToken) {
    // Fail closed, loudly. A reachable server that demands auth but has no
    // token to compare against can never authorise anyone, and serving
    // everyone instead would be the very bug this guard exists to prevent.
    throw new Error(
      "http transport: server.requireAuth is on but no cloud token is configured — " +
        "set TESTRELIC_MCP_TOKEN, or set TESTRELIC_MCP_REQUIRE_AUTH=false only if an " +
        "authenticating proxy sits in front of this server.",
    );
  }
  if (!requireAuth && !isLoopbackHost(host)) {
    getLogger().warn(
      { host },
      "http transport: caller authentication is DISABLED on a non-loopback bind — " +
        "anyone who can reach this port can run tools as the configured identity.",
    );
  }

  /** Constant-time compare, over digests so a length mismatch cannot throw
   *  (and cannot leak the token's length either). */
  const tokenMatches = (presented: string): boolean =>
    timingSafeEqual(
      createHash("sha256").update(presented).digest(),
      createHash("sha256").update(expectedToken).digest(),
    );

  const authorize = (req: Request, res: Response): boolean => {
    if (!requireAuth) return true;
    const header = req.header("authorization") ?? "";
    // Parsed by index, NOT by regex. `/^Bearer\s+(.+)$/` backtracks
    // catastrophically on attacker-controlled input — CodeQL flagged it as
    // polynomial ReDoS ("slow on strings starting with 'bearer ' and with many
    // repetitions of ' '"), and an unauthenticated request is exactly where an
    // attacker controls this string. This scan is linear and allocation-light.
    const sep = header.indexOf(" ");
    const presented =
      sep > 0 && header.slice(0, sep).toLowerCase() === "bearer"
        ? header.slice(sep + 1).trim()
        : undefined;
    if (presented && tokenMatches(presented)) return true;
    getLogger().warn(
      { hasHeader: Boolean(header) },
      "http transport: rejected an unauthenticated /mcp request",
    );
    res.setHeader("WWW-Authenticate", 'Bearer realm="testrelic-mcp"');
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message:
          "This MCP server requires a credential. Send Authorization: Bearer <TESTRELIC_MCP_TOKEN>.",
      },
    });
    return false;
  };

  /**
   * Rate limit on the authorizing routes.
   *
   * An endpoint that checks a credential and will answer as fast as you can
   * ask is a guessing oracle, so the limiter goes on with the auth check
   * rather than after it. The token is 64 hex characters, so brute force is
   * not the realistic threat — flooding is, and this bounds it.
   *
   * ⚠ `trust proxy` is deliberately NOT enabled. Behind CloudFront → nginx
   * the client IP arrives only in `X-Forwarded-For`, which a caller can spoof;
   * trusting it would let an attacker mint a fresh bucket per request and
   * evade the limit entirely. Untrusted, `req.ip` is the proxy, so this
   * behaves as a near-global ceiling. That is the honest trade: a real
   * per-client limit needs an authenticated identity, which is what the
   * per-caller-PAT work would provide. The ceiling is set high enough that a
   * legitimate MCP session — which makes many rapid tool calls — never sees
   * it.
   */
  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests." } },
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  app.post("/mcp", mcpLimiter, async (req: Request, res: Response) => {
    if (!authorize(req, res)) return;
    const sessionHeader = req.header("mcp-session-id");
    let transport = sessionHeader ? transports.get(sessionHeader) : undefined;

    if (!transport) {
      const newSessionId = randomUUID();
      const sessionServer = buildServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
        onsessioninitialized: (id: string) => {
          transports.set(id, transport!);
          servers.set(id, sessionServer);
        },
        onsessionclosed: (id: string) => {
          transports.delete(id);
          const s = servers.get(id);
          servers.delete(id);
          if (s) void s.close().catch(() => undefined);
        },
      });
      await sessionServer.connect(transport);
    }

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      getLogger().error({ err }, "http transport request failed");
      if (!res.headersSent) res.status(500).json({ error: "transport error" });
    }
  });

  app.get("/mcp", mcpLimiter, async (req: Request, res: Response) => {
    if (!authorize(req, res)) return;
    const sessionHeader = req.header("mcp-session-id");
    const transport = sessionHeader ? transports.get(sessionHeader) : undefined;
    if (!transport) {
      res.status(400).json({ error: "missing or invalid mcp-session-id" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", mcpLimiter, async (req: Request, res: Response) => {
    if (!authorize(req, res)) return;
    const sessionHeader = req.header("mcp-session-id");
    const transport = sessionHeader ? transports.get(sessionHeader) : undefined;
    if (!transport) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    await transport.close();
    transports.delete(sessionHeader!);
    const s = servers.get(sessionHeader!);
    servers.delete(sessionHeader!);
    if (s) await s.close().catch(() => undefined);
    res.json({ ok: true });
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(port, host, () => {
      getLogger().info({ host, port, version, capabilities: config.capabilities }, "http transport listening");
      resolve(async () => {
        for (const [, t] of transports) {
          try {
            await t.close();
          } catch {
            // ignore
          }
        }
        transports.clear();
        for (const [, s] of servers) {
          try {
            await s.close();
          } catch {
            // ignore
          }
        }
        servers.clear();
        await new Promise<void>((done) => httpServer.close(() => done()));
      });
    });
  });
}
