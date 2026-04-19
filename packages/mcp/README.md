# @testrelic/mcp

TestRelic Model Context Protocol (MCP) server for AI coding assistants.

> **v3.0.0 — cloud-wired.** The only thing you configure is one token. Every
> integration (Jira, Amplitude, Grafana Loki, GitHub) is resolved server-side
> from the authenticated user's organisation in cloud-platform-app — the MCP
> never holds third-party secrets.

## What it does

- **Test creation**: Turn a real user journey into a runnable Playwright/Cypress/Jest/Vitest test with stable locators and assertions.
- **Auto-healing**: Given a failing run, propose a minimal unified-diff patch — swap brittle selectors, bump timeouts, adjust assertions.
- **Coverage gap detection**: Rank uncovered journeys by real user count and show partial overlaps with existing tests.
- **Test impact & prioritisation**: From a diff, select MUST/SHOULD/OPTIONAL tests and quantify the blast-radius on real users.
- **Triage & operations**: Flaky audit, diagnose, RCA, Jira dedupe, production signal correlation — all through the `triage`/`signals`/`devtools` capabilities.

## Configure once: authenticate

1. Open `https://app.testrelic.ai/settings/mcp-tokens` (or your cloud-platform-app instance).
2. Click **Create Token**, copy the `tr_mcp_*` value.
3. Store it:

```bash
npx @testrelic/mcp login            # prompts and writes ~/.testrelic/token
# or
export TESTRELIC_MCP_TOKEN=tr_mcp_…  # any shell, CI, container
```

That's it. All integrations (Jira, Amplitude, Loki, GitHub) are pulled from
`/api/v1/mcp/bootstrap` at startup — no per-service credentials live on your
laptop or in the MCP config.

## Quick start

```json
{
  "mcpServers": {
    "testrelic": {
      "command": "npx",
      "args": ["-y", "@testrelic/mcp", "--caps", "core,coverage,creation,healing,impact"]
    }
  }
}
```

With the local mock server (no cloud account needed):

```bash
npm run mock             # starts http://localhost:4000/api/v1
npx @testrelic/mcp --caps core,coverage,creation --mock-mode
```

## CLI

```bash
mcp-server-testrelic login [--token=tr_mcp_…] [--cloud-url=https://your-instance]
mcp-server-testrelic [options]
```

| Flag | Type | Notes |
|---|---|---|
| `--caps` | csv | Enabled capabilities. `core` is always on. |
| `--config` | path | JSON config file (see `src/config.d.ts`). |
| `--port` | int | Start HTTP transport on this port. stdio when unset. |
| `--host` | string | HTTP bind host. Default `127.0.0.1`. |
| `--cloud-url` | url | Base URL for cloud-platform-app. Default `https://app.testrelic.ai/api/v1`, or `<mockServerUrl>/api/v1` with `--mock-mode`. Env: `TESTRELIC_CLOUD_URL`. |
| `--token` | str | MCP PAT (`tr_mcp_*`). Falls back to `TESTRELIC_MCP_TOKEN` then `~/.testrelic/token`. |
| `--default-repo-id` | uuid | Repo to use when a tool doesn't specify `project_id`. |
| `--output-dir` | path | Traces, reports, `metrics.jsonl`. Default `./.testrelic-output`. |
| `--cache-dir` | path | SQLite/HNSW/blob caches. Default `./.testrelic-cache`. |
| `--isolated` | flag | Wipe `cacheDir` at boot. |
| `--save-session` | flag | Persist cache across restarts. Default on. |
| `--shared-repo-context` | flag | Share CodeMap across tool calls in the same session. |
| `--mock-mode` | flag | Point the cloud client at the local mock-server instead of prod. |
| `--mock-server-url` | url | Default `http://localhost:4000`. |
| `--log-level` | enum | `debug` / `info` / `warn` / `error`. |
| `--token-budget` | int | Per-tool token budget ceiling. Default 4000. |

## Environment variables

Auth + URL:

- `TESTRELIC_MCP_TOKEN` — the one credential the MCP needs.
- `TESTRELIC_CLOUD_URL` — override the cloud base URL (e.g. stage).
- `TESTRELIC_DEFAULT_REPO_ID` — default repo for tools that omit `project_id`.

Operational:

- `TESTRELIC_MCP_CAPS`, `TESTRELIC_MCP_PORT`, `TESTRELIC_MCP_HOST`,
  `TESTRELIC_MCP_OUTPUT_DIR`, `TESTRELIC_MCP_CACHE_DIR`, `TESTRELIC_MCP_ISOLATED`,
  `TESTRELIC_MCP_LOG_LEVEL`, `TESTRELIC_MOCK_MODE`, `MOCK_SERVER_URL`.

> **Removed in v2.1.** The per-integration env vars (`AMPLITUDE_*`,
> `JIRA_*`, `LOKI_*`, `CLICKHOUSE_*`, `TESTRELIC_API_*`) are no longer read.
> See `MIGRATION.md` for the upgrade path from v2.0.

## Programmatic API

```ts
import { createServer } from "@testrelic/mcp";

const { start, stop, registeredTools } = await createServer({
  capabilities: ["core", "coverage", "creation"],
  server: { port: 3000 },
});

await start();
// ... later
await stop();
```

## Resources & prompts

Resources (read-only URIs):

- `testrelic://repos/{repo_id}/journeys`
- `testrelic://repos/{repo_id}/coverage-report`
- `testrelic://repos/{repo_id}/gaps`
- `testrelic://cache/{cache_key}`

Ready-made prompts exposed to clients:

- `create_test_from_gap` — end-to-end journey → test flow.
- `triage_and_heal` — diagnose → RCA → heal → Jira.
- `pr_impact_gate` — risk-rank tests for a diff.

## Tools

<!-- TOOLS-START -->

_Auto-generated. Edit the tool source files, then run `npm run update-readme`._

| Capability | Tool | Purpose |
|---|---|---|
| `core` | `tr_describe_repo` | Describe a repo. Returns a repo's integrations and capabilities. Sourced from the startup bootstrap — zero additional upstream calls. |
| `core` | `tr_get_config` | Resolved server config. Returns the resolved configuration — capabilities, transport, timeouts, cache/output dirs. Safe to call early to learn what tools/resources are available. |
| `core` | `tr_health` | Server health. Reports upstream connectivity, cache state, and whether any circuit breakers are open. Call this before a long workflow to fail fast if something is down. |
| `core` | `tr_integration_status` | Check integration health. Returns a live health check for one integration type in the current org (e.g. 'jira', 'amplitude', 'grafana-loki'). Call this when a tool that depends on an integration fails with INTEGRATION_NOT_CONNECTED — the error message tells you where to configure it in the cloud UI. |
| `core` | `tr_list_repos` | List TestRelic repos. Lists repos the authenticated user can see in cloud-platform-app. Sourced from /api/v1/mcp/bootstrap — no upstream fetch per call. Use this first when you don't know which repo_id (== repoId) to target. |
| `core` | `tr_recent_runs` | List recent test runs. Paginated list of recent runs. Supports filters by project, framework, status. Prefer this as the cheap entry point before diagnosing a specific run. |
| `coverage` | `tr_coverage_gaps` | Ranked coverage gaps. Returns the top-N user journeys with NO test covering them, ordered by user count. Each gap includes the pp coverage gain we'd get by covering it and any partial overlaps with existing tests. |
| `coverage` | `tr_coverage_report` | Coverage report (95% readout). Returns user_coverage and test_coverage metrics with progress toward the 95/95 targets. Repeat calls return a 3-state diff (unchanged / diff / full) to cut token usage on iteration. |
| `coverage` | `tr_fetch_cached` | Fetch a cached full payload. Fetches a payload referenced by a cache_key returned from another tool. Used to opt into large content only when needed (token efficiency). |
| `coverage` | `tr_test_map` | Test-to-journey/code-node map. Returns the test coverage map for a project — every test_id with the journeys and code nodes it exercises. Large responses are written to the blob store and summarised. |
| `coverage` | `tr_user_journeys` | Top N Amplitude user journeys. Returns the top N user journeys for a project ordered by distinct users in the last 30 days. Uses L1+L2 cache with a 1h TTL. |
| `creation` | `tr_dry_run_test` | Dry-run: tsc + framework list. Type-checks the generated file (`tsc --noEmit`) and lists tests (`playwright test --list` when applicable). Returns first-pass errors so the agent can iterate before committing. |
| `creation` | `tr_generate_assertion` | Generate a stable assertion. TestRelic parallel to Playwright's browser_generate_locator. Given a journey step, returns a stable framework-appropriate assertion the agent can paste into a test. |
| `creation` | `tr_generate_test` | Generator — produce runnable test code. Generates runnable test code (Playwright by default) from a plan. Uses sampling for synthesis with a deterministic template fallback. Writes to {outputDir}/generated/ and returns both the code and a cache_key. |
| `creation` | `tr_list_templates` | List framework templates. Returns available test framework templates (Playwright, Cypress, Jest, Vitest). |
| `creation` | `tr_plan_test` | Planner — design a test plan. Produces a Markdown test plan for a journey gap. Input either a journey_id (preferred) or a freeform goal. Missing PRD/acceptance info is requested via elicitation; the result is cache-keyed on the journey signature. |
| `devtools` | `tr_active_alerts` | Active platform alerts. Returns active TestRelic platform alerts (flakiness spikes, pass-rate drops, etc.). |
| `devtools` | `tr_cache_stats` | Cache stats. Returns L1/L2/L3/L4 cache counters. Useful for verifying token reduction in benchmarks. |
| `devtools` | `tr_index_repo` | Index a local repo into the code map. Walks a local repo root, extracts function/class nodes (tree-sitter when available, regex fallback), and indexes them in the vector store for tr_search_code. |
| `devtools` | `tr_project_trends` | Project quality trends. Returns pass-rate, duration, and flakiness trends for a project over the last N days. |
| `devtools` | `tr_search_code` | Semantic search over the code map. Vector search across indexed code nodes. Returns top-k neighbors with score and location. Requires a prior tr_index_repo or platform code map load. |
| `healing` | `tr_heal_run` | Healer — propose a patch for a failing run. Analyses a failing run's stack trace, error message, and test source, then proposes a patch (unified diff) to stabilise the test. Typical fixes: brittle-selector swap, timeout bump, flakiness gate, or assertion correction. |
| `healing` | `tr_replay_failure` | Replay a failure locally. Returns the artefacts (trace, video, screenshots) and a replay plan the agent can follow offline to reproduce the failure without hitting upstream services. |
| `healing` | `tr_suggest_locator` | Suggest a stable locator. Given a brittle selector (CSS / xpath / text), returns stable alternatives — getByRole, getByTestId, getByLabel — in order of preference. Framework-agnostic output. |
| `impact` | `tr_analyze_diff` | Analyze a diff for test impact. Parses a unified diff (or filename list) and returns the affected code nodes, the tests touching them, and an initial risk score based on Amplitude user counts on touched journeys. |
| `impact` | `tr_risk_score` | Risk score for a diff. Lightweight blast-radius estimate using only Amplitude user counts on journeys whose tests cover the changed files. Faster than tr_analyze_diff when the agent only needs a go/no-go signal. |
| `impact` | `tr_select_tests` | Select tests for a diff. Ranks tests into MUST / SHOULD / OPTIONAL buckets for a given diff. MUST = directly touches changed code. SHOULD = shares journey with a touched test. OPTIONAL = broader safety net. |
| `signals` | `tr_affected_sessions` | Amplitude sessions hit by a run's failures. Returns Amplitude sessions affected by a failing run (cohort for targeted communication or rollback). |
| `signals` | `tr_production_signal` | Query production logs (Loki) for a signal. Ad-hoc Loki LogQL query over a time window. Results are trimmed and cached (5 min TTL). |
| `signals` | `tr_user_impact` | Correlate a run with user impact. Pulls Amplitude affected-user counts and Loki error-rate for a failing run. Returns the business-level blast radius so the agent can prioritise. |
| `triage` | `tr_ai_rca` | AI root cause analysis. Fetches the platform-generated RCA for a run (falls back to sampling when the platform has none). |
| `triage` | `tr_compare_runs` | Compare two runs. Diffs two runs for regressions, fixes, and persistent failures. |
| `triage` | `tr_create_jira` | Create a Jira ticket (with dedupe). Creates or returns an existing Jira ticket for a run. Populates with RCA and user impact when available. |
| `triage` | `tr_diagnose_run` | Diagnose a failing run. Pulls run metadata, all failures, and ClickHouse flakiness scores; returns a compact diagnostic with video markers (when include_video is true). |
| `triage` | `tr_dismiss_flaky` | Dismiss a test as known flaky. Marks a test as known-flaky (suppresses alerts) with a required reason. |
| `triage` | `tr_flaky_audit` | Flaky-test audit. Ranks flaky tests above a threshold over a lookback window. |
| `triage` | `tr_list_runs` | List recent runs (legacy alias of tr_recent_runs). Alias retained for v1 compatibility; behaviour identical to tr_recent_runs under the core capability. |
| `triage` | `tr_search_failures` | Search failures by text. Searches recent failed runs for text matches across test names, error messages, and stack traces. |
| `triage` | `tr_suggest_fix` | Platform-suggested fix. Returns the TestRelic platform's code-level fix suggestion for a named test in a run. |

<!-- TOOLS-END -->

## Token-efficiency design

- **Capability gating** — the LLM only sees tool schemas for enabled `--caps`.
- **Structured outputs** — compact Markdown + JSON `structuredContent`.
- **L1 (LRU) → L2 (SQLite) → L3 (HNSW) → L4 (blob) cache** — every tool is cache-first.
- **3-state reads** (`full` / `unchanged` / `diff`) for repeat reads of large payloads.
- **Sampling bridge** — synthesis offloaded to the client's model; no server-side LLM key.
- **Per-tool token budget** (`tokenBudgetPerTool`) with automatic truncation + `cache_key` pointer to the full blob.

## Testing

```bash
npm run test        # vitest
npm run ctest       # contract tests only
npm run ttest       # token-budget baselines
npm run dtest       # Docker-mode tests (MCP_IN_DOCKER=1)
```

## License

AGPL-3.0-only
