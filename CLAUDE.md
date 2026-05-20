# CLAUDE.md — testrelic-mcp-server

Read this first. Everything in this file is current and verified against
the code. When you change anything structural, update this file.

## What this repo is

A **Model Context Protocol (MCP)** server plus IDE extension that gives
AI coding assistants *testing intelligence* for TestRelic customers.
Four intelligence cases:

1. **Test creation** — plan → generate → dry-run tests anchored on real
   Amplitude journeys.
2. **Auto-healing** — turn failing runs into concrete patch proposals.
3. **Coverage gaps** — rank missing tests by real user impact.
4. **Impact / prioritisation** — pick the minimum set of tests to run
   for a given diff.

## Monorepo layout

```
testrelic-mcp-server/
├── package.json                 (workspace root)
├── tsconfig.base.json           (strict TS defaults)
├── tsconfig.json                (project references)
├── vitest.config.ts
├── mock-server/                 (Express app for fixtures)
│   ├── index.ts
│   ├── data/                    (runs, journeys, coverage, etc.)
│   └── routes/                  (testrelic, amplitude, loki, jira, clickhouse)
├── packages/
│   ├── mcp/                     (@testrelic/mcp — the server)
│   │   ├── src/
│   │   │   ├── cli.ts           (yargs-driven binary)
│   │   │   ├── index.ts         (createServer programmatic API)
│   │   │   ├── config.ts        (Zod schema)
│   │   │   ├── config.d.ts      (public types)
│   │   │   ├── errors.ts
│   │   │   ├── logger.ts        (pino → stderr)
│   │   │   ├── version.ts
│   │   │   ├── cache/           (L1 LRU, L2 SQLite, L3 HNSW, L4 blob, diff-reader)
│   │   │   ├── clients/         (axios + retry/cb/rate-limit → ONE cloud client + legacy adapter shims)
│   │   │   ├── context/         (journey graph, coverage map, code map, signal map, correlator)
│   │   │   ├── sampling/        (client-LLM bridge)
│   │   │   ├── elicit/          (structured input)
│   │   │   ├── registry/        (capability-gated tool registry)
│   │   │   ├── resources/       (testrelic:// URIs)
│   │   │   ├── prompts/         (canned workflows)
│   │   │   ├── telemetry/       (tokens, metrics.jsonl)
│   │   │   ├── transport/       (stdio, streamable http)
│   │   │   └── tools/           (core, coverage, creation, healing, impact, triage, signals, devtools)
│   │   ├── scripts/             (update-readme, copy-config)
│   │   ├── Dockerfile
│   │   └── README.md
│   └── extension/               (VSCode/Cursor host)
│       ├── src/extension.ts
│       └── package.json
├── tests/
│   ├── fixtures/server.ts
│   ├── contract/tools.test.ts
│   └── baselines/tokens.test.ts
└── configs/, local-deployments/  (legacy, do not modify without checking with the user)
```

## Key contracts

### Authentication (v2.1)

**One credential.** The MCP reads `config.cloud.token` (a `tr_mcp_*` PAT) from:
1. `--token` CLI flag, or
2. `TESTRELIC_MCP_TOKEN` env, or
3. `~/.testrelic/token` (written by `mcp-server-testrelic login`).

Every outbound HTTP call sets `Authorization: Bearer <token>` and hits
`config.cloud.baseUrl` (default prod, or `${mockServerUrl}/api/v1` in
`--mock-mode`). Per-service credentials (Amplitude/Jira/Loki/GitHub) live
only in cloud-platform-app's Postgres — the MCP never sees them.

At startup the MCP calls `GET /api/v1/mcp/bootstrap` once and caches the
response on `ctx.bootstrap` (user, organisation, repos, connected
integrations + capabilities). Tools that need a repo use
`resolveProjectId(ctx, input.project_id)` from `src/registry/project.ts`.

### Capabilities

Always on: `core`. Gated: `coverage`, `creation`, `healing`, `impact`,
`triage`, `signals`, `devtools`, `config`, `ai`, `marketplace`, `apps`,
`artifacts`, `sessions`. Filter via `--caps` or `TESTRELIC_MCP_CAPS`.

The five newest capabilities surface the platform's Ask-AI and integration
features to external MCP clients:

- `ai` — Ask-AI tool catalog, single-turn agent, conversation management,
  and granular artifact generators (dashboards, reports, test plans,
  presentations, navigation paths).
- `marketplace` — first-class testing integrations (Jira, GitHub Actions,
  BrowserStack, LambdaTest, Sentry, Amplitude, Grafana Loki): catalog,
  validate / connect / OAuth-start, disconnect, and unified `invoke`.
- `apps` — generic action runner for connected apps (Slack, Notion,
  Linear, HubSpot, Google Calendar, etc.): list, list actions, connect /
  disconnect via OAuth, and universal `execute`.
- `artifacts` — list / get / export (PNG, PDF) / save-to-file for
  artifacts produced by the Ask-AI agent. Each artifact is also
  addressable as `testrelic://artifacts/{id}`.
- `sessions` — cloud test session workspaces (BrowserStack / LambdaTest):
  search, video, screenshots, logs, multi-pane workspace render.

### Tool naming

- `tr_*` for v2 tools.
- `testrelic_*` aliases preserve v1 compatibility.
- Every tool returns `{ text: string; structured?: object }`. Handlers
  may set `isError: true`.

### Coverage formulas

- `user_coverage = Σ(user_count of covered journeys) / Σ(user_count of all journeys)`
- `test_coverage = covered_code_nodes / total_code_nodes`

### Token-efficiency contracts

- Plain LLM prompting baseline for the same workflow must be >60%
  higher than what the MCP produces. Baselines are pinned in
  `tests/baselines/tokens.test.ts`.
- Every read tool supports `read_mode = auto | full`, with `auto`
  triggering the 3-state diff reader.

## How to run locally

```bash
npm install
npm run mock          # terminal 1 — cloud-platform-app mock on http://localhost:4000/api/v1
npm run dev           # terminal 2 — MCP server on stdio, --mock-mode (no token required)
```

Or use `npm run dev:mock` to run both concurrently. In `--mock-mode` every
tool is green without secrets. To talk to a real stage/prod cloud, drop
`--mock-mode`, set `TESTRELIC_CLOUD_URL` + `TESTRELIC_MCP_TOKEN`, and run
normally.

## How to test

```bash
npm run ctest         # contract tests
npm run ttest         # token baselines
npm run test          # everything
```

## Before you commit

1. `npm run typecheck`
2. `npm run test`
3. `npm run roll` — regenerates README tool tables (in
   `packages/mcp/README.md`) and copies config types. Run this after
   adding, removing, or renaming any tool / capability — the README's
   capability-tool tables are derived from `ALL_TOOLS`, so the
   `ai`, `marketplace`, `apps`, `artifacts`, and `sessions` sections only
   appear once a maintainer rolls the README.

## Smoke / E2E

`npm run smoke` boots the MCP in-process against the local mock server
and walks the canonical `core` → `ai` → `marketplace` → `apps` →
`artifacts` sequence, asserting each step is non-error. Useful as a
fast pre-PR sanity check that doesn't require a real token. See
`scripts/smoke-e2e.ts` — accepts `--caps=...` to narrow the surface.

## Cursor Agent Skill

A Cursor Agent Skill for this repo lives at:

```
.cursor/skills/testrelic-mcp/SKILL.md
```

It documents auth, transports, `--caps`, tools, prompts, resources, bootstrap
edge cases, and truncation recovery — grounded against the source code. Read
it before writing any agent that invokes `tr_*` tools. The `examples.md`
alongside it covers the three registered MCP prompt workflows.

## Hard rules

- **Never** log to stdout — pino writes to stderr so the MCP handshake is intact.
- **Never** introduce a tool without an `outputSchema` if it returns structured data; the 3-state diff reader depends on stable shapes.
- **Never** import from `packages/extension` inside `packages/mcp`; the extension is the host, not vice versa.
- **Never** bypass `ServiceClient` for outbound HTTP — retry, circuit breaker, and metrics depend on it.
- **Never** call Amplitude/Jira/Loki/GitHub/ClickHouse directly; the MCP only talks to `cloud-platform-app`. Add new capabilities by extending `CloudOps` in `packages/mcp/src/clients/cloud.ts` and the corresponding proxy on the platform.
- **Never** commit real credentials. Mock mode is the default for dev.
