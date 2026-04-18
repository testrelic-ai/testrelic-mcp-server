# testrelic-mcp-server

TestRelic Model Context Protocol (MCP) server — a production-grade MCP
surface for AI coding assistants that delivers **intelligent testing
context** for:

1. **Test creation** (journey-backed tests, ≥95% user coverage, ≥95% test coverage, >60% fewer tokens than plain LLM prompting).
2. **Auto-healing** of failing selectors, waits, and assertions.
3. **Coverage-gap detection** over real Amplitude user journeys.
4. **Test impact / prioritisation** for PR diffs.

---

## For Cursor users

This repository is published as a plugin in the
[Cursor Marketplace](https://cursor.com/marketplace). The plugin surface
is intentionally tiny: a manifest (`.cursor-plugin/plugin.json`), an
`mcp.json` that launches the bundled server from `packages/mcp/dist/cli.js`,
a logo, and docs. No binaries, no remote-fetched scripts, no third-party
credentials.

> **Marketplace submission pre-requisite:** the `mcp.json` currently uses the
> vendored local `dist/` build (works immediately from a git clone or the
> Cursor local-plugin install). Once `@testrelic/mcp` is published to npm,
> update `mcp.json` to `npx -y @testrelic/mcp@<version>` before the final
> marketplace submission so end-users don't need the source repo.

### Install from the marketplace

1. Open Cursor and search **Settings → Plugins** for `testrelic-mcp`.
2. Click **Install**. Cursor wires up the MCP server automatically.
3. Open the agent and ask something like “list my TestRelic projects”.

That’s it. The marketplace default boots the server in **mock mode** so
you can explore every tool — `tr_list_repos`, `tr_coverage_report`,
`tr_heal_run`, `tr_analyze_diff`, etc. — without any account or token.

### Manual install (equivalent `mcp.json`)

If you prefer to wire the server by hand from a local clone, add this to
your Cursor MCP configuration — it is identical to what the plugin ships:

```json
{
  "mcpServers": {
    "testrelic": {
      "command": "node",
      "args": [
        "packages/mcp/dist/cli.js",
        "--caps", "core,coverage,creation,healing,impact",
        "--mock-mode"
      ],
      "env": {}
    }
  }
}
```

Cursor runs this with the plugin directory as the working directory, so
`packages/mcp/dist/cli.js` resolves relative to the install path. No npm
package or internet access is required.

### Mock mode by default — no secrets required

In mock mode the MCP makes **zero outbound network calls**. Everything
resolves from the local fixtures shipped with the plugin, so a reviewer
or first-time user can audit the full tool surface safely.

### Connect real data

When you are ready to point the plugin at your TestRelic cloud:

1. Visit `https://app.testrelic.ai/settings/mcp-tokens` and create a
   `tr_mcp_*` personal access token.
2. Store it with either approach:
   - Run `npx @testrelic/mcp login` (writes `~/.testrelic/token`), or
   - Export `TESTRELIC_MCP_TOKEN=tr_mcp_…` in your shell / CI.
3. Remove `--mock-mode` from the `args` array (or override it in your
   Cursor MCP config).

Every outbound call then goes to your configured
`TESTRELIC_CLOUD_URL` (default `https://app.testrelic.ai/api/v1`) with
`Authorization: Bearer <token>` — and nowhere else. Per-service
credentials (Amplitude, Jira, Grafana Loki, GitHub) never live on your
machine; they are resolved inside the TestRelic cloud platform.

### Preview the plugin locally

Reviewers and plugin authors can preview this repository as a Cursor
plugin without publishing anything:

```bash
# macOS / Linux
./scripts/link-local-plugin.sh

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File scripts/link-local-plugin.ps1
```

Each script creates a symlink at `~/.cursor/plugins/local/testrelic-mcp`
pointing at this repo. Restart Cursor, open
**Settings → Features → Model Context Protocol**, and confirm the
`testrelic` server is listed. In the agent, run `tr_health` — it must
succeed in mock mode with no environment variables set.

### Security

See [SECURITY.md](SECURITY.md) for the disclosure policy, supported
versions, and the full plugin threat model. Vulnerabilities go to
[security@testrelic.ai](mailto:security@testrelic.ai).

---

## For maintainers

This is a **monorepo** with two packages:

| Package | Description |
|---|---|
| `packages/mcp` | The MCP server (`@testrelic/mcp`). CLI binary: `mcp-server-testrelic`. |
| `packages/extension` | VSCode/Cursor extension that hosts the server in the editor process. |

## Quick start

```bash
# 1. Install workspace deps
npm install

# 2. Start the mock server (fixtures for journeys, coverage, runs, Loki, Jira, etc.)
npm run mock

# 3. Start the MCP server against the mock
npm run dev -- --caps core,coverage,creation,healing,impact --mock-mode
```

In another terminal point an MCP-aware client (Claude Desktop, Cursor, VS
Code Copilot Chat, OpenAI MCP bridge, etc.) at:

```json
{
  "mcpServers": {
    "testrelic": {
      "command": "node",
      "args": [
        "packages/mcp/dist/cli.js",
        "--caps", "core,coverage,creation,healing,impact",
        "--mock-mode"
      ],
      "cwd": "/absolute/path/to/testrelic-mcp-server"
    }
  }
}
```

## Workspace scripts

| Command | Purpose |
|---|---|
| `npm run build` | Build every package. |
| `npm run typecheck` | Typecheck every package. |
| `npm run dev` | Run `@testrelic/mcp` via `tsx` (stdio). |
| `npm run dev:http` | Run `@testrelic/mcp` on HTTP (port 3000). |
| `npm run dev:mock` | Run the mock server and the MCP server concurrently. |
| `npm run mock` | Start the mock server at `http://localhost:4000`. |
| `npm run roll` | `copy-config` then `update-readme`. |
| `npm run test` | Run all vitest suites. |
| `npm run ctest` | Contract tests only. |
| `npm run ttest` | Token-budget baselines only. |
| `npm run dtest` | Docker-mode tests (`MCP_IN_DOCKER=1`). |

## Intelligence surface

Capabilities map 1:1 to tool groups. `core` is always on; everything else
is gated behind `--caps`:

- `core` — projects, recent runs, resolved config, health.
- `coverage` — user journeys, test map, coverage gaps, coverage report.
- `creation` — planner → generator → dry-run → assertion helper.
- `healing` — patch proposals, locator suggestions, replay plans.
- `impact` — diff analysis, risk score, MUST/SHOULD/OPTIONAL test selection.
- `triage` — v1 migration (diagnose, flaky audit, compare runs, AI RCA, Jira dedupe, dismiss flakiness).
- `signals` — Amplitude user impact + Loki production signal.
- `devtools` — project trends, active alerts, semantic code search, cache stats.

Every new tool is prefixed `tr_*`. Existing v1 flat names (`testrelic_*`)
are registered as deprecated aliases to avoid breaking older integrations.

## Configuration precedence

```
CLI flags > environment (TESTRELIC_MCP_*) > --config file > defaults
```

See `packages/mcp/src/config.d.ts` for the full schema. The Zod schema in
`packages/mcp/src/config.ts` is the runtime source of truth; `copy-config`
keeps the two in sync.

## Token-efficiency architecture

| Layer | Storage | Notes |
|---|---|---|
| L1 | `lru-cache` in-process | 60 s TTL, sized by count. |
| L2 | `better-sqlite3` (fallback: in-memory map) | 1 h–24 h TTL, namespace invalidation. |
| L3 | `hnswlib-node` + `@xenova/transformers` BGE-small embeddings (fallback: linear scan with hash-based embedder) | Semantic search over the code map. |
| L4 | Filesystem blob store keyed by SHA256 | Large payloads referenced by `cache_key`. |

On top of caching, the server uses:

- **Capability gating** to cut the tool schema by ~4×.
- **Per-tool token budget** with automatic truncation + `cache_key` pointer.
- **3-state reads** (`full` / `unchanged` / `diff`) via SimHash.
- **Sampling bridge** → client-side LLM for code synthesis (no server-side LLM key).
- **Elicitation** for structured follow-up questions.

## Deployment

Deployment is out of scope for this repo — the MCP server is intended to
be installed client-side via `npx -y @testrelic/mcp`, hosted in the IDE via
the extension, or dropped into Kubernetes via the provided Dockerfile.

Don't commit credentials. The mock server runs locally with zero secrets.
