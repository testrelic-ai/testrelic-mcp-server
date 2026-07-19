# TestRelic MCP — workflow examples

Each example maps a real goal to the MCP primitive that handles it most
directly. Prompt names are the server-registered values from
`packages/mcp/src/prompts/index.ts`; tool names from the respective
`tools/**/index.ts` files.

---

## Example 1 — Write a test for the highest-impact coverage gap

**MCP prompt:** `create_test_from_gap`

**When to use:** You want to generate a production-anchored test without
manually picking the right journey.

**Step-by-step (what the prompt does internally):**

1. `tr_list_repos` — confirm `project_id` (if not already known)
2. `tr_coverage_gaps project_id=<uuid> limit=3` — returns top 3 uncovered journeys ranked by user count
3. `tr_plan_test journey_id=<top result> framework=playwright` — produces a test plan and caches it
4. `tr_generate_test plan_cache_key=<key from step 3>` — emits the full test file
5. `tr_dry_run_test file_path=<path from step 4>` — TypeScript type-checks without running a browser

**Invoke via Cursor slash command (if client supports MCP prompts):**

```
/create_test_from_gap project_id=<uuid> framework=playwright
```

**Or invoke manually with the tools in order if prompts are not available:**

```
tr_coverage_gaps  →  tr_plan_test  →  tr_generate_test  →  tr_dry_run_test
```

**Large result tip:** If `tr_coverage_report` returns a short text block,
check `structuredContent.cacheKey` and call `tr_fetch_cached` for the full payload.

---

## Example 2 — Triage a failing run, correlate impact, propose a fix

**MCP prompt:** `triage_and_heal`

**When to use:** A test run has failed and you want root-cause analysis,
user-impact quantification, a locator/assertion heal, and optionally a Jira
ticket — all from a single prompt.

**Step-by-step (what the prompt does internally):**

1. `tr_diagnose_run run_id=<uuid>` — failure summary: which tests, error types, timings
2. `tr_user_impact run_id=<uuid>` — how many real users hit the broken flow
3. `tr_ai_rca run_id=<uuid>` — AI root-cause analysis (requires `triage` cap)
4. `tr_heal_run run_id=<uuid>` — proposes a minimal unified-diff patch
5. If user impact is high: `tr_create_jira dry_run=true` — surfaces Jira ticket draft for confirmation

**Invoke via Cursor:**

```
/triage_and_heal run_id=<uuid>
```

**Caps required:** `core,triage,signals,healing`

**If you only need the diagnosis without a heal:**

```
tr_diagnose_run  →  tr_user_impact  →  tr_ai_rca
```

---

## Example 3 — Risk-rank tests before merging a PR

**MCP prompt:** `pr_impact_gate`

**When to use:** You have a unified diff and want to know which tests are
MUST-run, SHOULD-run, or OPTIONAL before merging.

**Step-by-step (what the prompt does internally):**

1. `tr_analyze_diff project_id=<uuid> unified_diff=<diff string>` — parses changed symbols, maps to journeys
2. `tr_select_tests project_id=<uuid> unified_diff=<diff string>` — bucketed test list with risk score

**Invoke via Cursor:**

```
/pr_impact_gate project_id=<uuid> unified_diff=<paste diff here>
```

**Caps required:** `core,impact`

**Expected output:** risk level (LOW / MEDIUM / HIGH), MUST-run test names,
SHOULD-run test names, which user journeys are at risk.

---

## Example 4 — Orientation when bootstrap may have failed

This is not a registered prompt — it is a manual recovery sequence.

```
tr_health            # verify server is up, caps list, version
tr_list_repos        # if empty → token is missing or bootstrap failed
tr_describe_repo project_id=<uuid>   # once you have the ID
```

If `tr_list_repos` returns empty, set `--default-repo-id` in the MCP config
(or pass `project_id` explicitly to every subsequent tool) rather than
retrying bootstrap.

---

## Example 5 — Retrieve a truncated large payload

Tools truncate responses to 4000 tokens. When `structuredContent.cacheKey`
is present, the full payload is in the cache.

```
# Option A — call the tool
tr_fetch_cached cache_key=<key from structuredContent>

# Option B — fetch the resource URI
testrelic://cache/<key>
```

Use this when `tr_coverage_report` or `tr_coverage_gaps` returns fewer
entries than expected.

---

## Example 6 — Semantic code search before test generation

**Caps required:** `core,devtools,creation`

```
tr_index_repo repo_root=/absolute/path/to/repo   # first time only
tr_search_code query="checkout payment handler" k=5
tr_plan_test journey_id=<uuid>                   # anchored on a real journey
tr_generate_test plan_cache_key=<key>
```

Index the repo once per session; the vector store persists across calls
unless `--isolated` was passed.
