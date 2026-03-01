# TestRelic MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI assistants (Claude, Cursor, etc.) structured access to test analytics, flakiness detection, user impact correlation, and automated triage actions.

The server integrates with **TestRelic** (test analytics), **Amplitude** (user session data), **Grafana Loki** (production logs), **Jira** (ticketing), and **ClickHouse** (flakiness scoring). All integrations fall back to a local mock server when real API credentials are not configured, so you can develop and test the full workflow without any external accounts.

---

## Contents

- [Quick Start — Mock Mode](#quick-start--mock-mode)
- [Project Structure](#project-structure)
- [Environment Configuration](#environment-configuration)
- [IDE Integration](#ide-integration)
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
- [Tools Reference](#tools-reference)
- [Resources Reference](#resources-reference)
- [Prompts Reference](#prompts-reference)
- [Sample Tests with Mock Data](#sample-tests-with-mock-data)
- [Mock Data Reference](#mock-data-reference)
- [Running Against Real APIs](#running-against-real-apis)

---

## Quick Start — Mock Mode

Mock mode runs the full tool surface using a local Express server that serves realistic fixture data. No external accounts or API keys are required.

```bash
# 1. Install dependencies
npm install

# 2. Copy the example env file — no edits needed for mock mode
cp .env.example .env

# 3. Start both the mock API server (port 4000) and the MCP server (stdio)
npm run dev:mock
```

To run them separately in two terminals:

```bash
# Terminal 1 — mock API server
npm run mock

# Terminal 2 — MCP server
npm run dev
```

To verify the mock server is up:

```bash
curl http://localhost:4000/health
# → {"status":"ok","server":"testrelic-mock-api","timestamp":"..."}
```

---

## Project Structure

```
testrelic-mcp-server/
├── src/
│   ├── index.ts              # Entry point — transport selection & auth validation
│   ├── server.ts             # MCP server wiring (tools, resources, prompts)
│   ├── auth/
│   │   └── validate.ts       # Credential guards + agent-readable error formatting
│   ├── clients/
│   │   ├── testrelic.ts      # TestRelic API client
│   │   ├── clickhouse.ts     # ClickHouse flakiness query client
│   │   ├── amplitude.ts      # Amplitude user session client
│   │   ├── loki.ts           # Grafana Loki log query client
│   │   └── jira.ts           # Jira issue client
│   ├── tools/
│   │   ├── analytics/        # diagnose-failure, list-runs, get-flaky-tests, compare-runs, search-failures
│   │   ├── user-impact/      # correlate-user-impact, get-production-signal, get-affected-sessions
│   │   └── actions/          # get-ai-rca, create-jira-ticket, suggest-fix, dismiss-flaky
│   ├── resources/index.ts    # 6 MCP resources (read-only context)
│   ├── prompts/index.ts      # 5 MCP prompts (multi-step workflow templates)
│   └── types/index.ts        # Shared TypeScript interfaces
├── mock-server/
│   ├── index.ts              # Express app, routes, port 4000
│   ├── routes/               # testrelic, clickhouse, amplitude, loki, jira
│   └── data/                 # Fixture data: runs, failures, flaky-tests, etc.
├── dist/                     # Compiled output (generated, not committed)
├── .env.example              # Environment variable template
├── package.json
└── tsconfig.json
```

---

## Environment Configuration

Copy `.env.example` to `.env`. For mock mode, the defaults work without any changes.

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Transport mode. Only `stdio` is supported (HTTP is Phase 2). |
| `PORT` | `3000` | Port for HTTP transport (Phase 2, not yet active). |
| `MOCK_SERVER_URL` | `http://localhost:4000` | Base URL for the mock API server. Used by all clients when real credentials are absent. |
| `TESTRELIC_API_BASE_URL` | _(empty)_ | Set to your TestRelic instance URL to use real data. |
| `TESTRELIC_API_KEY` | _(empty)_ | Required when `TESTRELIC_API_BASE_URL` is set. |
| `AMPLITUDE_API_KEY` | _(empty)_ | Amplitude project API key. |
| `AMPLITUDE_SECRET_KEY` | _(empty)_ | Amplitude secret key (required alongside `AMPLITUDE_API_KEY`). |
| `LOKI_BASE_URL` | _(empty)_ | Grafana Loki base URL. |
| `LOKI_USERNAME` | _(empty)_ | Required when `LOKI_BASE_URL` is set. |
| `LOKI_PASSWORD` | _(empty)_ | Required when `LOKI_BASE_URL` is set. |
| `JIRA_BASE_URL` | _(empty)_ | Your Jira instance URL, e.g. `https://yourorg.atlassian.net`. |
| `JIRA_EMAIL` | _(empty)_ | Required when `JIRA_BASE_URL` is set. |
| `JIRA_API_TOKEN` | _(empty)_ | Required when `JIRA_BASE_URL` is set. Get one from [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens). |

**Fallback logic:** Each client checks whether its real API URL is set. If it is not, the client routes all requests to `MOCK_SERVER_URL` instead. You can mix real and mock — for example, use a real TestRelic instance while keeping Amplitude and Loki on mock.

---

## IDE Integration

The server uses **stdio transport** (Phase 1). It runs as a child process managed by your IDE.

### Claude Desktop

1. Build the server:
   ```bash
   npm run build
   ```

2. Add the following to your `claude_desktop_config.json` (usually at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

   ```json
   {
     "mcpServers": {
       "testrelic": {
         "command": "node",
         "args": ["/absolute/path/to/testrelic-mcp-server/dist/index.js"],
         "env": {
           "MOCK_SERVER_URL": "http://localhost:4000",
           "MCP_TRANSPORT": "stdio"
         }
       }
     }
   }
   ```

   > If you are running against real APIs, add the relevant API keys to the `"env"` block.

3. Start the mock API server before launching Claude Desktop (so tools have data to return):
   ```bash
   npm run mock
   ```

4. Restart Claude Desktop. You should see the TestRelic tools available.

### Cursor

1. Open **Settings → MCP** and add a new server entry:

   ```json
   {
     "testrelic": {
       "command": "npx",
       "args": ["tsx", "/absolute/path/to/testrelic-mcp-server/src/index.ts"],
       "env": {
         "MOCK_SERVER_URL": "http://localhost:4000",
         "MCP_TRANSPORT": "stdio"
       }
     }
   }
   ```

   Or point to the compiled build:
   ```json
   {
     "testrelic": {
       "command": "node",
       "args": ["/absolute/path/to/testrelic-mcp-server/dist/index.js"],
       "env": {
         "MOCK_SERVER_URL": "http://localhost:4000",
         "MCP_TRANSPORT": "stdio"
       }
     }
   }
   ```

2. Start the mock server separately:
   ```bash
   npm run mock
   ```

---

## Tools Reference

### Group 1 — Test Analytics

#### `testrelic_diagnose_failure`

Full failure analysis for a test run: errors, stack traces, flakiness scores, and video markers.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id` | string | Yes | The test run ID to diagnose, e.g. `RUN-2847` |
| `include_video` | boolean | No | Include video URL and timestamp markers in the response (default: `false`) |

---

#### `testrelic_list_runs`

Paginated list of test runs with pass/fail summary.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | No | Filter by project ID, e.g. `PROJ-1` |
| `framework` | enum | No | Filter by framework: `playwright`, `cypress`, `jest`, `vitest` |
| `status` | enum | No | Filter by status: `passed`, `failed`, `running`, `cancelled` |
| `cursor` | string | No | Pagination cursor — pass the `next_cursor` from a previous response |
| `limit` | integer | No | Number of results (1–20, default: 5) |

---

#### `testrelic_get_flaky_tests`

Returns tests ranked by flakiness score above a threshold.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | No | Filter by project ID |
| `days` | integer | No | Lookback window in days (1–90, default: 7) |
| `threshold` | number | No | Minimum flakiness score (0.0–1.0, default: 0.3) |

---

#### `testrelic_compare_runs`

Diffs two test runs — what regressed, what improved, and what remains broken in both.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id_a` | string | Yes | The first run ID (usually the newer run) |
| `run_id_b` | string | Yes | The second run ID (usually the baseline) |

---

#### `testrelic_search_failures`

Full-text search across test names, error messages, and stack traces across recent failed runs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Text to search for |
| `project_id` | string | No | Limit search to a specific project |
| `date_range` | string | No | ISO date range as `YYYY-MM-DD/YYYY-MM-DD`, e.g. `2026-02-25/2026-02-28` |

---

### Group 2 — User Impact Correlation

#### `testrelic_correlate_user_impact`

Links a test failure to Amplitude user count and Loki error rate in production. Returns the real-user blast radius and log spike correlated to the test failure window.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id` | string | Yes | The test run ID to correlate against production signals |
| `lookback_minutes` | integer | No | Minutes before/after the run to look for correlated events (1–1440, default: 60) |

---

#### `testrelic_get_production_signal`

Pulls Grafana Loki logs filtered by an error pattern. Returns error rates, peak times, and raw log lines.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `error_pattern` | string | Yes | Error pattern to search for in Loki logs, e.g. `checkout_payment_failed` or `TimeoutError` |
| `time_range` | string | No | ISO time range as `start/end`, e.g. `2026-02-28T13:00:00Z/2026-02-28T15:00:00Z` |

---

#### `testrelic_get_affected_sessions`

Returns Amplitude session IDs and metadata for users who hit the same failure path as the test run.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id` | string | Yes | The test run ID whose failure path to trace in Amplitude |
| `limit` | integer | No | Maximum sessions to return (1–100, default: 50) |

---

### Group 3 — AI Root Cause & Actions

#### `testrelic_get_ai_rca`

Fetches AI root cause analysis for a test failure: root cause summary, confidence score, supporting evidence, and suggested fix.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id` | string | Yes | The test run ID to fetch root cause analysis for |

---

#### `testrelic_create_jira_ticket`

Creates a pre-filled Jira issue with RCA, stack trace, and user impact count. Deduplicates first — returns the existing ticket if one already exists for this run.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id` | string | Yes | The test run ID to file a ticket for |
| `project_key` | string | No | Jira project key, e.g. `ENG` or `PLATFORM` (default: `ENG`) |
| `priority` | enum | No | `P1`, `P2`, `P3`, `P4` (default: `P2`) |
| `dry_run` | boolean | No | If `true`, preview the ticket without creating it (default: `false`) |

---

#### `testrelic_suggest_fix`

Returns a code-level fix suggestion for a failing test, including a unified diff and affected files.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id` | string | Yes | The test run ID containing the failing test |
| `test_name` | string | Yes | The full test name, e.g. `Checkout > Payment > completes purchase with valid card` |

---

#### `testrelic_dismiss_flaky`

Marks a test as known flaky to suppress alerts and CI noise. Records the reason so the team understands why it was suppressed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `test_id` | string | Yes | The test ID to mark as known flaky, e.g. `TEST-checkout-001` |
| `reason` | string | Yes | Reason for dismissing (minimum 10 characters) |

---

## Resources Reference

Resources are read-only context that the AI can reference directly without tool calls.

| Resource URI | Description |
|---|---|
| `testrelic://projects/{project_id}/config` | Project settings, registered frameworks, and active integrations |
| `testrelic://runs/{run_id}/summary` | Lightweight run summary: counts, duration, status, branch, commit |
| `testrelic://runs/{run_id}/full` | Complete run data including all failure details and stack traces |
| `testrelic://projects/{project_id}/flaky-report` | Flaky test leaderboard for a project, ranked by flakiness score |
| `testrelic://projects/{project_id}/trends` | 7-day pass rate, run duration, test volume, and flaky count trends |
| `testrelic://alerts/active` | Currently firing alerts across all projects |

**Example usage in a prompt:**

```
Read testrelic://projects/PROJ-1/config
```

---

## Prompts Reference

Prompts are reusable multi-step workflow templates. They chain several tools together behind a single invocation.

#### `testrelic_full_debug`

Full debug workflow: diagnose → correlate user impact → AI RCA → (optionally) create Jira ticket.

| Argument | Required | Description |
|---|---|---|
| `run_id` | Yes | The test run ID to fully diagnose |
| `jira_project` | No | Jira project key to create a ticket in, e.g. `ENG`. Omit to skip ticket creation. |

---

#### `testrelic_weekly_report`

Generates a weekly QA health report covering pass rate trends, top failures, flaky leaderboard, and active alerts.

| Argument | Required | Description |
|---|---|---|
| `project_id` | Yes | The project ID to report on, e.g. `PROJ-1` |
| `week` | No | ISO week range as `YYYY-MM-DD/YYYY-MM-DD`. Defaults to the last 7 days. |

---

#### `testrelic_flaky_audit`

Audits all flaky tests above a threshold and produces a prioritised action plan: fix now / suppress / monitor.

| Argument | Required | Description |
|---|---|---|
| `project_id` | Yes | The project ID to audit |
| `threshold` | No | Minimum flakiness score (0.0–1.0, default: `0.3`) |

---

#### `testrelic_regression_review`

Compares a run against a baseline and produces a regression report with a ship/block verdict.

| Argument | Required | Description |
|---|---|---|
| `run_id` | Yes | The current run to review |
| `baseline_run_id` | Yes | The stable baseline run to compare against |

---

#### `testrelic_incident_triage`

P0 incident triage: diagnose → user blast radius → AI RCA → file P1 Jira ticket → (optionally) draft a Slack update.

| Argument | Required | Description |
|---|---|---|
| `run_id` | Yes | The test run ID associated with the incident |
| `slack_channel` | No | Slack channel to draft an update for, e.g. `#incidents` |

---

## Sample Tests with Mock Data

The mock server is pre-loaded with two projects and eleven test runs. All sample prompts below work out of the box with `npm run dev:mock`.

### Listing runs

```
List the last 5 test runs for project PROJ-1
```
```
List all failed runs for project PROJ-1 using testrelic_list_runs
```
```
List all Cypress test runs for PROJ-2 using testrelic_list_runs
```

---

### Diagnosing a failed run

RUN-2847 is the richest mock run: 14 failures across the checkout and cart suites with full stack traces, retry counts, and video markers.

```
Diagnose run RUN-2847 using testrelic_diagnose_failure
```
```
Diagnose run RUN-2847 and include video markers
```
```
Diagnose run RUN-2849 — what failed in the auth and search suites?
```

---

### Flaky test analysis

```
Show me all flaky tests for project PROJ-1 with testrelic_get_flaky_tests
```
```
Which tests in PROJ-1 have a flakiness score above 0.7?
```
```
Mark TEST-email-confirm-001 as known flaky — reason: External SMTP provider has variable delivery latency in staging
```

---

### Comparing runs

```
Compare run RUN-2849 against baseline RUN-2850 using testrelic_compare_runs
```
```
Compare RUN-2847 vs RUN-2845 — what changed between the two failed runs?
```

---

### Searching failures

```
Search for all failures matching "TimeoutError" using testrelic_search_failures
```
```
Search for failures containing "checkout" in project PROJ-1
```
```
Search for failures matching "payment" between 2026-02-25 and 2026-02-28
```

---

### User impact correlation

RUN-2847 and RUN-2849 have full Amplitude + Loki mock data for correlation.

```
Correlate user impact for run RUN-2847 using testrelic_correlate_user_impact
```
```
How many real users were affected by the failures in RUN-2849?
```
```
Get affected Amplitude sessions for run RUN-2847
```

---

### Production signal

```
Get production signal for error pattern "checkout_payment_failed" using testrelic_get_production_signal
```
```
Query Loki for "TimeoutError" to see if it reached production
```

---

### AI root cause analysis

RCA mock data is available for RUN-2847 (payment gateway timeout, 87% confidence) and RUN-2849 (Redis connection pool exhaustion, 79% confidence).

```
Get the AI root cause analysis for RUN-2847 using testrelic_get_ai_rca
```
```
What is the root cause of the failures in RUN-2849?
```

---

### Fix suggestions

```
Suggest a fix for the failing test "Checkout > Payment > completes purchase with valid card" in run RUN-2847
```

---

### Creating Jira tickets

```
Create a Jira ticket for run RUN-2847 using testrelic_create_jira_ticket
```
```
Preview a Jira ticket for RUN-2849 without creating it (use dry_run=true)
```
```
File a P1 Jira ticket in project ENG for run RUN-2847
```

---

### Multi-step prompts

These use the built-in prompt templates to chain tools automatically.

```
Run testrelic_full_debug for run RUN-2847
```
```
Run testrelic_full_debug for RUN-2847 and create a Jira ticket in project ENG
```
```
Generate a testrelic_weekly_report for project PROJ-1
```
```
Run a testrelic_flaky_audit for project PROJ-1
```
```
Run testrelic_regression_review comparing RUN-2849 against baseline RUN-2850
```
```
Run testrelic_incident_triage for run RUN-2847
```

---

## Mock Data Reference

### Projects

| Project ID | Name | Framework | Integrations |
|---|---|---|---|
| `PROJ-1` | Commerce Platform | Playwright | Amplitude, Loki, Jira, ClickHouse |
| `PROJ-2` | Mobile API | Cypress | Amplitude, Jira, ClickHouse |

### Test Runs

| Run ID | Project | Status | Failed | Flaky | Branch | Notes |
|---|---|---|---|---|---|---|
| `RUN-2850` | PROJ-1 | passed | 0 | 1 | main | Latest passing run |
| `RUN-2849` | PROJ-1 | failed | 11 | 2 | main | Auth + search failures; has AI RCA |
| `RUN-2848` | PROJ-1 | passed | 0 | 0 | feature/cart-redesign | Feature branch run |
| `RUN-2847` | PROJ-1 | failed | 14 | 3 | main | Checkout/cart failures; has AI RCA + full mock data |
| `RUN-2846` | PROJ-1 | passed | 0 | 1 | main | — |
| `RUN-2845` | PROJ-1 | failed | 9 | 4 | main | Checkout timeout recurrence |
| `RUN-2844` | PROJ-1 | passed | 0 | 2 | main | — |
| `RUN-2843` | PROJ-2 | failed | 16 | 1 | main | API 503 failures (no video) |
| `RUN-2842` | PROJ-2 | passed | 0 | 0 | main | — |
| `RUN-2841` | PROJ-1 | passed | 0 | 3 | main | — |
| `RUN-2840` | PROJ-1 | failed | 20 | 5 | main | Checkout + avatar upload failures |

### Flaky Tests (PROJ-1)

| Test ID | Test Name | Flakiness | Known Flaky |
|---|---|---|---|
| `TEST-checkout-001` | Checkout > Payment > completes purchase with valid card | 82% | No |
| `TEST-cart-network-001` | Cart > network retry > handles intermittent 503 from inventory service | 74% | No |
| `TEST-search-sort-001` | Search > sort by relevance > maintains order on page refresh | 67% | No |
| `TEST-email-confirm-001` | Registration > email confirmation > arrives within 30 seconds | 61% | Yes — SMTP latency |
| `TEST-analytics-001` | Dashboard > Analytics chart > renders with real-time data | 55% | No |
| `TEST-checkout-004` | Checkout > Shipping > applies promo code discount | 48% | No |

### Active Alerts

| Alert ID | Type | Severity | Description |
|---|---|---|---|
| `ALERT-001` | `flakiness_spike` | critical | TEST-checkout-001 flakiness reached 0.82 — above threshold of 0.50 |
| `ALERT-002` | `pass_rate_drop` | warning | PROJ-1 pass rate dropped to 94.6% over last 3 runs |

---

## Running Against Real APIs

Set the relevant variables in your `.env` file. Each integration is independent — you can mix real and mock.

```env
# Use real TestRelic (requires both)
TESTRELIC_API_BASE_URL=https://app.testrelic.ai
TESTRELIC_API_KEY=your_key_here

# Use real Amplitude (requires both)
AMPLITUDE_API_KEY=your_api_key
AMPLITUDE_SECRET_KEY=your_secret_key

# Use real Grafana Loki
LOKI_BASE_URL=https://logs-prod.grafana.net
LOKI_USERNAME=your_username
LOKI_PASSWORD=your_service_account_token

# Use real Jira
JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_EMAIL=you@yourorg.com
JIRA_API_TOKEN=your_api_token
```

Then start the server normally (no mock server needed for configured integrations):

```bash
npm run dev
# or, for production
npm run build && npm start
```
