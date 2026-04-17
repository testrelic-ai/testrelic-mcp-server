# testrelic-mcp-server

TestRelic Model Context Protocol (MCP) server — a production-grade MCP
surface for AI coding assistants that delivers **intelligent testing
context** for:

1. **Test creation** (journey-backed tests, ≥95% user coverage, ≥95% test coverage, >60% fewer tokens than plain LLM prompting).
2. **Auto-healing** of failing selectors, waits, and assertions.
3. **Coverage-gap detection** over real Amplitude user journeys.
4. **Test impact / prioritisation** for PR diffs.

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
