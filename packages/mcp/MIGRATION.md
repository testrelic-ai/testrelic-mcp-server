# Migrating from @testrelic/mcp v2.0 to v2.1

v2.1 wires the MCP directly to `cloud-platform-app`. Authentication is the
only thing you configure; everything else (Jira / Amplitude / Grafana Loki /
GitHub Actions URLs and credentials) is resolved server-side from your
organisation's integrations.

## TL;DR

1. Generate an MCP Personal Access Token at `https://<your-cloud>/settings/mcp-tokens`.
2. `export TESTRELIC_MCP_TOKEN=tr_mcp_…` (or run `mcp-server-testrelic login`).
3. Remove every `AMPLITUDE_*`, `JIRA_*`, `LOKI_*`, `CLICKHOUSE_*`, and `TESTRELIC_API_*` env var — they're ignored in v2.1.

## Config schema changes

### Removed

The entire `integrations` block is gone from the config schema:

```diff
- integrations: {
-   testrelic?: { baseUrl?, apiKey? };
-   amplitude?: { apiKey, secretKey, projectId? };
-   loki?: { baseUrl?, username?, password? };
-   jira?: { baseUrl?, email?, apiToken?, defaultProjectKey? };
-   clickhouse?: { url? };
- }
```

### Added

```diff
+ cloud: {
+   baseUrl?: string;       // default https://app.testrelic.ai/api/v1
+   token?: string;         // the MCP PAT
+   defaultRepoId?: string; // optional; otherwise elicited per-tool
+ }
```

## Env vars

| v2.0 | v2.1 |
|---|---|
| `AMPLITUDE_API_KEY`, `AMPLITUDE_SECRET_KEY`, `AMPLITUDE_PROJECT_ID` | (removed) |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DEFAULT_PROJECT_KEY` | (removed) |
| `LOKI_BASE_URL`, `LOKI_USERNAME`, `LOKI_PASSWORD` | (removed) |
| `CLICKHOUSE_URL` | (removed) |
| `TESTRELIC_API_BASE_URL`, `TESTRELIC_API_KEY` | `TESTRELIC_CLOUD_URL`, `TESTRELIC_MCP_TOKEN` |
| `MOCK_SERVER_URL` | unchanged |

Configure the third-party integrations themselves in the cloud UI at
`/settings/integrations` — their credentials never leave the server.

## CLI flags

- Removed: per-integration flags (there weren't any, but the env vars are gone).
- Added: `--cloud-url`, `--token`, `--default-repo-id`.
- New subcommand: `mcp-server-testrelic login` — prompts for the PAT and
  writes it to `~/.testrelic/token` with `0600` permissions.

## Programmatic API

`createServer()` now accepts `cloud` instead of `integrations`:

```ts
import { createServer } from "@testrelic/mcp";

const { start, config } = await createServer({
  cloud: {
    baseUrl: "https://app.testrelic.ai/api/v1",
    token: process.env.TESTRELIC_MCP_TOKEN,
  },
  capabilities: ["core", "coverage", "healing"],
});
await start();
```

The exported type `IntegrationConfig` was removed; use `CloudConfig` instead.

## Behavioural changes

- **One-shot bootstrap.** At startup, the MCP calls `GET /api/v1/mcp/bootstrap`
  once, caches the user/org/repo/integration summary on `ctx.bootstrap`, and
  serves `tr_list_repos` / `tr_describe_repo` / `tr_integration_status`
  from that cached view. Startup is blocking-free: a failed bootstrap just
  logs a warning and tools fall back to explicit `repo_id` params.
- **`repo_id` semantics.** In v2.1, `repo_id` is the cloud-platform-app
  `repos.id` (UUID) or the `gitId` slug. The bootstrap-backed resolver in
  `src/registry/project.ts` accepts either.
- **Flakiness.** Reads from the platform's already-computed `flakiness_scores`
  table via `GET /api/v1/mcp/flakiness` (v2.0 hit ClickHouse directly).
- **Mock mode.** `--mock-mode` now points the cloud client at
  `${mockServerUrl}/api/v1`, which mirrors cloud-platform-app's route shape
  1:1. The legacy `/testrelic`, `/jira`, `/loki`, `/amplitude`, `/clickhouse`
  namespaces on the mock server are kept for backwards compatibility but are
  no longer the primary path.

## Errors the LLM will see if misconfigured

- `UNAUTHORIZED` — missing or invalid MCP token. Run `login` or set `TESTRELIC_MCP_TOKEN`.
- `INSUFFICIENT_SCOPE` — token lacks `jira:write` but tool attempted `POST /integrations/jira/issues`. Regenerate the token with the correct scope.
- `INTEGRATION_NOT_CONNECTED` — the org has no Jira/Amplitude/Loki integration. The error message includes the `/settings/integrations` URL.
- `PROJECT_REQUIRED` / `UNKNOWN_PROJECT` — no `project_id` and no `defaultRepoId`; or the supplied `project_id` doesn't match any repo the user can see.

## What stays the same

- All 30+ `tr_*` tool names and schemas. Tools that used to call Amplitude /
  Jira / Loki directly now call the cloud platform's proxy endpoints
  transparently — no agent prompt changes needed.
- Token-budget baselines, cache layers (L1 LRU / L2 SQLite / L3 HNSW / L4
  blob / 3-state diff), structured output, and capability gating.
