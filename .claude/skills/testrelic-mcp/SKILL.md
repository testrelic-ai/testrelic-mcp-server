---
name: testrelic-mcp
description: >-
  Use the TestRelic MCP server correctly. Load when the task involves running,
  configuring, or invoking TestRelic MCP tools (tr_*), diagnosing invocation
  failures, choosing capability flags, or registering the MCP server with any
  coding agent (Claude Code, Codex, Cursor, Copilot/VS Code, Gemini CLI,
  Windsurf, Zed). Covers auth, transports, capabilities, the full tool
  inventory, prompts, resources, bootstrap edge cases, token-budget recovery,
  and deprecated aliases.
---

# TestRelic MCP — usage guide for AI agents

This skill is grounded in the code under `packages/mcp/src/`. Do not invent
tool names, prompt names, resource URIs, or capability values — every name
below is verified against the source.

---

## 1. Authentication — two credentials, never conflated

| Credential | What it unlocks | Where to get it |
|---|---|---|
| `TESTRELIC_API_KEY` | SDK reporter (`@testrelic/playwright-analytics`) — uploads test results | Settings → API Keys |
| `tr_mcp_*` PAT | MCP server authentication to `cloud-platform-app` | Settings → MCP Tokens |

These are completely separate. **Never pass `TESTRELIC_API_KEY` as the MCP token.**

Store the MCP PAT via one of these (checked in priority order):
1. `--token tr_mcp_…` CLI flag
2. `TESTRELIC_MCP_TOKEN` environment variable
3. `~/.testrelic/token` (written by `npx @testrelic/mcp login`)

---

## 2. Transport — choose the right one

### Local / per-user (Cursor MCP, most common)

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

Add `"TESTRELIC_MCP_TOKEN": "tr_mcp_…"` to `env` if you are not using the login file.

### Team-shared or CI (Streamable HTTP)

```json
{
  "mcpServers": {
    "testrelic": {
      "url": "https://mcp-stage.testrelic.ai/mcp"
    }
  }
}
```

The repo-root `mcp.json` ships this HTTP form pre-pointed at staging. Do not use
the HTTP URL in a per-user Cursor setup — use stdio instead.

---

## 3. Capabilities and `--caps`

`core` is **always on**. Everything else is gated. Only tools for enabled caps
appear in the tool schema — a tool you cannot see is not available, do not call it.

Full capability list (source: `packages/mcp/src/config.ts` `CapabilitySchema`):

| Cap | Adds tools for |
|---|---|
| `core` | Repo listing, health, recent runs, integration status, config introspection |
| `coverage` | User-journey coverage, coverage gaps, coverage report, test map, cache fetch |
| `creation` | Test planning, test generation, dry-run, assertion generation, templates |
| `healing` | Auto-heal run, suggest locator, replay failure |
| `impact` | PR diff analysis, test selection, risk score |
| `triage` | Diagnose run, flaky audit, compare runs, search failures, AI RCA, suggest fix, Jira ticket, dismiss flaky, list runs |
| `signals` | User impact, production signal, affected sessions |
| `devtools` | Project trends, active alerts, semantic code search, local repo indexing, cache stats |
| `config` | Server configuration introspection (not in README quick-start; add explicitly when needed) |

### Scenario → recommended `--caps`

| Goal | Minimum caps |
|---|---|
| Orientation / health check | `core` |
| Coverage gap analysis | `core,coverage` |
| Write a new test from a gap | `core,coverage,creation` |
| Triage a failing run | `core,triage` |
| Triage + user-impact correlation | `core,triage,signals` |
| Auto-heal a failing run | `core,triage,healing` |
| PR test-impact gating | `core,impact` |
| Full investigation workflow | `core,coverage,creation,healing,triage,signals,impact` |
| Code search + trends | `core,devtools` |

If a tool call returns "tool not found", the corresponding cap is not in `--caps`.

---

## 4. Orientation — always start here

Before any capability-specific workflow, run one of these to confirm bootstrap
and discover the correct `repo_id`:

```
tr_list_repos      → lists repos from the bootstrap cache; empty = check token
tr_health          → server health + version + cap list
tr_describe_repo   → metadata for one repo
```

`repo_id` from `tr_list_repos` is the UUID you pass to all other tools as
`project_id`. Do not guess it.

---

## 5. Tools — canonical names (tr_*)

All tools are prefixed `tr_`. Use **only** these canonical names.

> This inventory is generated from the server's `ALL_TOOLS` array by
> `npm run update-skill`. Do not hand-edit it — the previous hand-maintained
> list silently drifted to 39 of 72 tools, omitting the entire `ai`,
> `marketplace`, `apps`, `artifacts`, and `memory` surfaces.

<!-- SKILL-TOOLS-START -->

### core _(always on)_
`tr_describe_repo` · `tr_fetch_cached` · `tr_get_config` · `tr_health` · `tr_integration_status` · `tr_list_repos` · `tr_recent_runs`

### coverage
`tr_coverage_gaps` · `tr_coverage_report` · `tr_test_map` · `tr_user_journeys`

### creation
`tr_dry_run_test` · `tr_generate_assertion` · `tr_generate_test` · `tr_list_templates` · `tr_plan_test`

### healing
`tr_heal_run` · `tr_replay_failure` · `tr_suggest_locator`

### impact
`tr_analyze_diff` · `tr_risk_score` · `tr_select_tests`

### triage
`tr_ai_rca` · `tr_compare_runs` · `tr_create_jira` · `tr_diagnose_run` · `tr_dismiss_flaky` · `tr_flaky_audit` · `tr_search_failures` · `tr_suggest_fix`

### signals
`tr_affected_sessions` · `tr_production_signal` · `tr_user_impact`

### devtools
`tr_active_alerts` · `tr_cache_stats` · `tr_index_repo` · `tr_project_trends` · `tr_search_code`

### ai
`tr_ai_delete_conversation` · `tr_ai_execute` · `tr_ai_get_conversation` · `tr_ai_list_conversations` · `tr_ai_list_tools` · `tr_ai_new_conversation` · `tr_ai_usage` · `tr_ask_ai`

### marketplace
`tr_marketplace_connect` · `tr_marketplace_disconnect` · `tr_marketplace_get_app` · `tr_marketplace_invoke` · `tr_marketplace_list_apps` · `tr_marketplace_list_connections` · `tr_marketplace_start_oauth` · `tr_marketplace_validate`

### apps
`tr_apps_connect` · `tr_apps_disconnect` · `tr_apps_execute` · `tr_apps_list` · `tr_apps_list_actions`

### artifacts
`tr_artifacts_export` · `tr_artifacts_get` · `tr_artifacts_list` · `tr_artifacts_save_to_file`

### memory
`tr_get_repo_memory` · `tr_list_repo_memories` · `tr_save_repo_memory`

_66 tools across 13 capabilities._
<!-- SKILL-TOOLS-END -->

### Deprecated aliases

The v1 `testrelic_*` names are **off by default** since 3.3.0. Enable them only
while migrating a v1 consumer, with `--legacy-aliases` or
`TESTRELIC_MCP_LEGACY_ALIASES=1`. If you see a tool description that says
`[DEPRECATED — use X]`, call `X` only. Never call a deprecated alias in new
workflows. The full mapping is in the package README.

### Choosing between overlapping fix tools

Three tools propose fixes for a failing run. They are not interchangeable:

- `tr_ai_rca` — run-scoped prose root-cause analysis; includes a
  `suggested_fix` summary. Start here to understand *why* a run failed.
- `tr_suggest_fix` — test-scoped, returns the **platform's** code-level diff
  plus `affected_files`. Requires `run_id` + `test_name`.
- `tr_heal_run` — test-scoped, synthesises a patch **locally** from the stack
  trace, error message, and test source.

`tr_suggest_fix` (capability `triage`) and `tr_heal_run` (capability `healing`)
both return a unified diff for one failing test. Prefer `tr_suggest_fix` when
the platform has already analysed the run; fall back to `tr_heal_run` when it
has not, or when `healing` is the only capability enabled.

---


## 6. MCP Prompts — prefer these over hand-built tool chains

The server registers three canned workflow prompts that chain tools in the
correct order. When the MCP client (Cursor, etc.) exposes prompts as slash
commands, invoke these instead of calling individual tools manually.

### `create_test_from_gap`
*Finds the top uncovered journey, plans, generates, and dry-runs a test.*

Args: `project_id` (required), `framework` (optional: playwright / cypress / jest / vitest)

Tool chain: `tr_coverage_gaps` → `tr_plan_test` → `tr_generate_test` → `tr_dry_run_test`

### `triage_and_heal`
*Diagnoses a failing run, correlates user impact, proposes a heal, optionally creates a Jira ticket.*

Args: `run_id` (required)

Tool chain: `tr_diagnose_run` → `tr_user_impact` → `tr_ai_rca` → `tr_heal_run` → `tr_create_jira` (if high impact)

### `pr_impact_gate`
*Risk-ranks tests for a PR diff into MUST / SHOULD / OPTIONAL buckets.*

Args: `project_id` (required), `unified_diff` (required)

Tool chain: `tr_analyze_diff` → `tr_select_tests`

---

## 7. MCP Resources — read-only URIs

Fetch these when you need raw data without a round-trip tool call. Cursor and
compatible clients can subscribe to resources via the `testrelic://` URI scheme.

| URI | Contents |
|---|---|
| `testrelic://repos/{repo_id}/journeys` | Top-N Amplitude-derived user journeys (JSON) |
| `testrelic://repos/{repo_id}/coverage-report` | Coverage report with targets (JSON) |
| `testrelic://repos/{repo_id}/gaps` | Top-N coverage gaps ranked by user count (JSON) |
| `testrelic://cache/{key}` | Full payload for a `cacheKey` returned by a prior tool call |

Use `testrelic://cache/{key}` to retrieve large payloads that were truncated
in a tool result (see §8).

---

## 8. Bootstrap failure — silent empty results

At startup the server calls `GET /api/v1/mcp/bootstrap` **once** (best-effort).
If it fails (bad token, network, offline), `ctx.bootstrap` is `undefined`. Tools
that read repos from bootstrap will return empty results — not an error.

**What to do when `tr_list_repos` returns no repos:**
1. Confirm the MCP token is set and valid (run `tr_health`).
2. Pass `project_id` / `repo_id` **explicitly** on every subsequent tool call
   rather than relying on auto-discovery from bootstrap.
3. Use `--default-repo-id <uuid>` in the MCP config to pre-set the fallback.

---

## 9. Token-budget truncation and cache recovery

Every tool result is truncated to `tokenBudgetPerTool` tokens (default 4000)
before returning text. Large reports (e.g. `tr_coverage_report` for a big repo)
may be silently cut.

**How to detect truncation:** The tool's `structuredContent` includes a
`cacheKey` field when the full payload was stored in L4 cache.

**How to recover the full payload:**
- Call `tr_fetch_cached` with the `cache_key` value, or
- Fetch the resource URI `testrelic://cache/{cacheKey}` directly.

Always check `structuredContent.cacheKey` before assuming a small result is
the complete dataset.

---

## 10. Registering this server with a coding agent

`testrelic-mcp-server/mcp.json` in the repo root is a **staging HTTP endpoint**
reference (`https://mcp-stage.testrelic.ai/mcp`), intended for team-shared or CI
environments. For local use, register the **stdio** command instead.

There is no cross-agent standard for MCP client config — the file path, the
top-level key, and the transport discriminator all differ. Use the row for the
agent you are configuring:

| Agent | Config file | Top-level key | Transport field |
|---|---|---|---|
| Claude Code | `.mcp.json` (project) / `~/.claude.json` | `mcpServers` | `type` is **required**: `"stdio"` \| `"http"` \| `"sse"` |
| Cursor | `.cursor/mcp.json` / `~/.cursor/mcp.json` | `mcpServers` | **No `type`** — inferred from `command` vs `url` |
| VS Code / Copilot | `.vscode/mcp.json` | `servers` (+ `inputs`) | `type: "http"` or `command` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.<id>]` (**TOML**) | `command`/`args` vs `url` |
| Gemini CLI | `.gemini/settings.json` | `mcpServers` | `command` \| `url` (SSE) \| `httpUrl` (streamable) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | `command` vs `url` |
| Zed | `settings.json` | `context_servers` | `source: "custom"` + `command` |

The two that most often bite: Claude Code **errors** on a `url` entry with no
`type`, and Cursor **rejects** a `type` field that Claude Code requires. Do not
copy one agent's block verbatim into another's config.

## 11. Where this skill lives

The source of truth is `.agents/skills/testrelic-mcp/SKILL.md`. That path is
read natively by Codex (its primary skills location), Cursor, Copilot/VS Code,
Gemini CLI, and Windsurf.

Claude Code reads `.claude/skills/` only, so a generated copy is mirrored there
by `npm run mirror-skills`. It is a copy rather than a symlink because symlinks
on Windows require Administrator or Developer Mode. Edit the `.agents/` copy and
re-run the mirror; never edit the `.claude/` copy directly.
