# testrelic-mcp-server — AI Context

## What This Repo Is

The **TestRelic MCP Server** — a Model Context Protocol (MCP) server that exposes TestRelic platform data as tools callable by AI assistants (Claude, Cursor, etc.). It allows AI assistants to query test runs, repositories, analytics, and failure insights directly from a conversation.

## Structure

```
testrelic-mcp-server/
  src/              Main MCP server source (TypeScript)
    index.ts        Server entry point — registers all tools and starts transport
    tools/          Individual MCP tool definitions (one file per tool)
    api/            TestRelic API client (wraps REST API calls)
    types/          TypeScript type definitions
  mock-server/      Local mock of the TestRelic API for development and testing
  dist/             Compiled JavaScript output (gitignored, built by tsc)
  tests/            Test suites (unit and integration)
  configs/          Infrastructure and deployment configs
  tsconfig.json     TypeScript configuration
  package.json      Dependencies and scripts
  .env.example      Environment variable template
  CLAUDE.md         This file
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 20+ (ESM) |
| Language | TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Transport | stdio (default) or HTTP (`MCP_TRANSPORT=http`) |

## Key Concepts

### MCP Tools
Each file in `src/tools/` defines one or more MCP tools. Tools follow the pattern:
- `name` — unique snake_case tool name
- `description` — what the tool does (shown to AI)
- `inputSchema` — Zod schema defining the input parameters
- `execute(input)` — async function that returns the tool result

### Mock Server
`mock-server/` simulates the TestRelic API without a live backend. Use it for development:
```bash
npm run dev:mock    # starts both mock server and MCP server
```

## Running Locally

```bash
# Install
npm install

# Development (stdio transport, uses real API)
npm run dev

# Development with mock server
npm run dev:mock

# HTTP transport (for testing with MCP Inspector)
npm run dev:http

# Build
npm run build
npm start
```

## Environment Variables

Copy `.env.example` to `.env`:
- `TESTRELIC_API_KEY` — API key for authenticating with the TestRelic platform
- `TESTRELIC_API_URL` — TestRelic API base URL (default: `https://platform.testrelic.ai/api/v1`)
