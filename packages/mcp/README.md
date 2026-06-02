# @testrelic/mcp

TestRelic Model Context Protocol (MCP) server for AI coding assistants.

> **v3.1.0 — cloud-wired + Ask-AI surface.** The only thing you configure is one token. Every
> integration (Jira, Amplitude, Grafana Loki, GitHub) is resolved server-side
> from the authenticated user's organisation in cloud-platform-app — the MCP
> never holds third-party secrets. v3.1 adds Ask AI, Marketplace, connected
> Apps, Artifacts, and Sessions surfaces — see capability table below.

## What it does

- **Test creation**: Turn a real user journey into a runnable Playwright/Cypress/Jest/Vitest test with stable locators and assertions.
- **Auto-healing**: Given a failing run, propose a minimal unified-diff patch — swap brittle selectors, bump timeouts, adjust assertions.
- **Coverage gap detection**: Rank uncovered journeys by real user count and show partial overlaps with existing tests.
- **Test impact & prioritisation**: From a diff, select MUST/SHOULD/OPTIONAL tests and quantify the blast-radius on real users.
- **Triage & operations**: Flaky audit, diagnose, RCA, Jira dedupe, production signal correlation — all through the `triage`/`signals`/`devtools` capabilities.

## Configure once: authenticate

1. Open `https://platform.testrelic.ai/settings/mcp-tokens` (or your cloud-platform-app instance).
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

### Try it without a cloud account (`--mock-mode`)

The mock server itself is not bundled in the npm package — it lives in the source repo. To run the MCP end-to-end without a `tr_mcp_*` PAT, clone the repo for the mock side:

```bash
# 1. Mock server (one-time clone)
git clone https://github.com/testrelic-ai/testrelic-mcp-server
cd testrelic-mcp-server
npm install
npm run mock                                # serves http://localhost:4000/api/v1

# 2. In another terminal, point the published MCP at it
npx -y @testrelic/mcp@latest --caps core,coverage,ai,marketplace,apps --mock-mode
```

Or just use the workspace script that runs both concurrently from the source repo:

```bash
npm run dev:mock
```

`--mock-mode` defaults `--cloud-url` to `http://localhost:4000/api/v1`, so no token is needed; the mock returns deterministic fixtures for every tool.

## Cursor Agent Skill

This package ships a Cursor Agent Skill that teaches your AI assistant to invoke
`tr_*` tools correctly — auth, capability flags, MCP prompts, resources, bootstrap
edge cases, and truncation recovery.

**Activate it in your project (one-time):**

```bash
# Copy the skill into your repo's .cursor directory
mkdir -p .cursor/skills/testrelic-mcp
cp node_modules/@testrelic/mcp/.cursor/skills/testrelic-mcp/SKILL.md \
   .cursor/skills/testrelic-mcp/SKILL.md
```

Or, if you used `npx` without installing:

```bash
mkdir -p .cursor/skills/testrelic-mcp
npx @testrelic/mcp --print-skill > .cursor/skills/testrelic-mcp/SKILL.md
```

Once the file is in `.cursor/skills/testrelic-mcp/SKILL.md`, Cursor loads it
automatically whenever you work in that repo — no further configuration needed.

> The skill covers: two-credential distinction (`TESTRELIC_API_KEY` vs `tr_mcp_*`),
> stdio vs HTTP transport, all capabilities including `config`, scenario → `--caps`
> table, the three registered MCP prompts, all resource URIs, bootstrap failure
> recovery, token-budget truncation + cache key retrieval, and deprecated alias
> guidance.

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
| `--cloud-url` | url | Base URL for cloud-platform-app. Default `https://platform.testrelic.ai/api/v1`, or `<mockServerUrl>/api/v1` with `--mock-mode`. Env: `TESTRELIC_CLOUD_URL`. |
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
| `ai` | `tr_ai_delete_conversation` | Delete an Ask-AI conversation. Permanently deletes a conversation and its messages. |
| `ai` | `tr_ai_execute` | Execute an Ask-AI tool. Invokes any AI tool by name. Body: { tool_name, input }. Returns { result, artifact? }. When the tool produces an artifact (dashboard, report, test_plan, presentation, navigation_paths, session_workspace), the artifact is also addressable as `testrelic://artifacts/{id}` after the call. |
| `ai` | `tr_ai_get_conversation` | Get one Ask-AI conversation. Returns the full message history for one conversation, including artifact references on assistant turns. |
| `ai` | `tr_ai_list_conversations` | List Ask-AI conversations. Paginated list of conversations for the authenticated user. Use this to find a conversationId to continue. |
| `ai` | `tr_ai_list_tools` | List Ask-AI tools. Catalog of every AI tool the platform exposes. Use this before `tr_ai_execute` to discover available tools and their input schemas. Output is paginated-friendly (one entry per tool). |
| `ai` | `tr_ai_new_conversation` | Create a new conversation. Creates an empty conversation. Use the returned `id` as `conversationId` in subsequent `tr_ask_ai` calls. |
| `ai` | `tr_ai_usage` | Ask-AI token usage. Current month's token usage vs the org's monthly budget. Use this to plan large Ask-AI workflows. |
| `ai` | `tr_ask_ai` | Ask AI (single turn). Runs the Ask AI agent loop for a single user message. The platform handles LLM calls, tool orchestration, and artifact generation. Returns the assistant's response plus any artifacts it produced. Pass `conversationId` to continue an existing thread, or omit to start a new one. |
| `apps` | `tr_apps_connect` | Connect an app. Initiates an OAuth connection for an app. Returns { redirectUrl, connectionId }. The user must open redirectUrl in a browser and complete the consent flow; the MCP cannot automate this. After consent, the connection becomes ACTIVE — poll `tr_apps_list` to confirm `connected: true`. |
| `apps` | `tr_apps_disconnect` | Disconnect an app. Revokes a connection. Subsequent `tr_apps_execute` calls for the same app will fail until reconnected. |
| `apps` | `tr_apps_execute` | Run an action on a connected app. Universal action runner. Body: { app, action, args }. Returns { ok, app, action, result }. Examples: send a Slack message, create a Notion page, create a Linear issue, post to HubSpot CRM, create a Google Calendar event, run a Salesforce query. The platform proxies the call using credentials it holds — never pass tokens or secrets in args. |
| `apps` | `tr_apps_list` | List connected apps. Catalog of every app the org can connect through the Apps gateway, with current connection state. Each entry has { slug, name, category, connected, connectionId }. Call this before `tr_apps_execute` to confirm the app is connected — if not, run `tr_apps_connect` first. |
| `apps` | `tr_apps_list_actions` | List actions an app exposes. Returns the action catalog for one connected app. Each action has { name, description, inputSchema }. Use this before `tr_apps_execute` to discover what operations are available (e.g. send_message, create_page, create_issue). |
| `artifacts` | `tr_artifacts_export` | Export artifact to PNG or PDF. Renders an artifact via the platform's headless export pipeline and returns a presigned S3 URL valid for ~1 hour. Use this for sharing or attaching to emails/PRs. |
| `artifacts` | `tr_artifacts_get` | Fetch one artifact. Returns the full JSON payload of one artifact. The payload shape depends on `type` — see the platform's artifact renderers for the contract. |
| `artifacts` | `tr_artifacts_list` | List artifacts. Paginated list of artifacts. Filterable by conversationId, repoId, type (dashboard, report, test_plan, presentation, navigation_paths, session_workspace, etc.). Returns id, type, title, createdAt — fetch full payload with `tr_artifacts_get`. |
| `artifacts` | `tr_artifacts_save_to_file` | Save artifact JSON to local file. Fetches an artifact and writes its JSON payload to a local file under the configured `outputDir`. Returns the absolute path so a downstream tool can hand it off (e.g. open in an editor). |
| `core` | `tr_describe_repo` | Describe a repo. Returns a repo's integrations and capabilities. Sourced from the startup bootstrap — zero additional upstream calls. |
| `core` | `tr_get_config` | Resolved server config. Returns the resolved configuration — capabilities, transport, timeouts, cache/output dirs. Safe to call early to learn what tools/resources are available. |
| `core` | `tr_health` | Server health. Reports upstream connectivity, cache state, and whether any circuit breakers are open. Call this before a long workflow to fail fast if something is down. |
| `core` | `tr_integration_status` | Check integration health. Returns a live health check for one integration type in the current org (e.g. 'jira', 'amplitude', 'grafana-loki'). Call this when a tool that depends on an integration fails with INTEGRATION_NOT_CONNECTED — the error message tells you where to configure it in the cloud UI. |
| `core` | `tr_list_repos` | List TestRelic repos. Lists repos the authenticated user can see in cloud-platform-app. Sourced from /api/v1/mcp/bootstrap — no upstream fetch per call. Use this first when you don't know which repo_id (== repoId) to target. |
| `core` | `tr_recent_runs` | List recent test runs. Recent automated TEST RUNS (Playwright / Cypress / Jest / Vitest). Returns each run's status, pass/fail counts, branch, commit, duration. Use this as the cheap first step whenever the user asks 'what tests ran', 'show me my runs', 'how did last night's tests go', 'any failing tests', 'which builds failed', 'recent test results'. Filterable by repo, framework, status (passed/failed/running). Drill into a specific run with tr_diagnose_run. |
| `coverage` | `tr_coverage_gaps` | Ranked coverage gaps. Returns the top-N user journeys with NO test covering them, ordered by user count. Each gap includes the pp coverage gain we'd get by covering it and any partial overlaps with existing tests. |
| `coverage` | `tr_coverage_report` | Test coverage report (95% readout). TEST COVERAGE for a repo — how much of the codebase is exercised by tests and how many user journeys are covered. Use when the user asks 'what's our test coverage', 'are we hitting 95%', 'how covered is repo X', 'coverage summary'. Returns user_coverage and test_coverage progress vs the 95/95 targets. Pair with tr_coverage_gaps to see what's missing. |
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
| `marketplace` | `tr_marketplace_connect` | Connect a Marketplace app. Installs an apikey / basic / pat app. For OAuth apps, use `tr_marketplace_start_oauth` instead. Body: { slug, credentials } — keys must match the app's configFields. Returns { ok, id }. |
| `marketplace` | `tr_marketplace_disconnect` | Disconnect a Marketplace app. Removes the app's credentials from the org. Existing test runs are unaffected. |
| `marketplace` | `tr_marketplace_get_app` | Get one Marketplace app. Returns full detail for one app, including configFields needed by `tr_marketplace_connect`. |
| `marketplace` | `tr_marketplace_invoke` | Invoke a Marketplace operation. Unified operation runner. Body: { slug, operation, args }. Each app exposes typed operations — e.g. jira.search, jira.create, github.runs, github.trigger, amplitude.events, browserstack.video, sentry.search, loki.query. The platform proxies using stored credentials; never pass tokens or secrets in args. |
| `marketplace` | `tr_marketplace_list_apps` | List Marketplace apps. Full Marketplace catalog with connection status. Each entry includes auth method, MCP capabilities unlocked when connected, and a coming-soon flag. Returns roughly 7 first-class testing integrations. |
| `marketplace` | `tr_marketplace_list_connections` | List active Marketplace connections. Returns just the connected apps for the org, with status and connectedAt. |
| `marketplace` | `tr_marketplace_start_oauth` | Start OAuth for a Marketplace app. Returns { redirectUrl, state } for OAuth-only Marketplace apps. The user must open redirectUrl in a browser; the MCP cannot automate this. Poll `tr_marketplace_get_app` until `connected: true`. |
| `marketplace` | `tr_marketplace_validate` | Validate Marketplace credentials. Validates credentials for an apikey / basic / pat app without writing them. Returns { ok, error? }. Use this before `tr_marketplace_connect` to surface auth issues without side effects. |
| `signals` | `tr_affected_sessions` | Amplitude sessions hit by a run's failures. Returns Amplitude sessions affected by a failing run (cohort for targeted communication or rollback). |
| `signals` | `tr_production_signal` | Query production logs (Loki) for a signal. Ad-hoc Loki LogQL query over a time window. Results are trimmed and cached (5 min TTL). |
| `signals` | `tr_user_impact` | Correlate a run with user impact. Pulls Amplitude affected-user counts and Loki error-rate for a failing run. Returns the business-level blast radius so the agent can prioritise. |
| `triage` | `tr_ai_rca` | AI root cause analysis. Fetches the platform-generated RCA for a run (falls back to sampling when the platform has none). |
| `triage` | `tr_compare_runs` | Compare two runs. Diffs two runs for regressions, fixes, and persistent failures. |
| `triage` | `tr_create_jira` | Create a Jira ticket (with dedupe). Creates or returns an existing Jira ticket for a run. Populates with RCA and user impact when available. |
| `triage` | `tr_diagnose_run` | Diagnose a failing test run. Drill into one TEST RUN — pulls run metadata, every failing test, error messages, stack traces, and flakiness scores. Use this when the user says 'why did this test run fail', 'what failed in run X', 'tell me about the failures', 'investigate this build', 'show me errors for run …'. Set include_video to also surface video timestamp markers for each failure. |
| `triage` | `tr_dismiss_flaky` | Dismiss a test as known flaky. Marks a test as known-flaky (suppresses alerts) with a required reason. |
| `triage` | `tr_flaky_audit` | Flaky-test audit. Lists flaky tests in this org — tests whose pass/fail status changes between retries. Use when the user says 'show me flaky tests', 'which tests are unstable', 'why are these tests intermittent', 'flakiness report'. Ranks by flakiness score over a lookback window; pair with tr_dismiss_flaky to mark a test as known-flaky. |
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
