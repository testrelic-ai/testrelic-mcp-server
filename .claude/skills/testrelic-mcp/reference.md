# TestRelic MCP — reference pointers

This file contains **only links to existing documentation** in this repo.
No external URLs are invented here.

---

## Auth + token resolution

`packages/mcp/CLAUDE.md` → section **Authentication (v2.1)**
`packages/mcp/README.md` → section **Configure once: authenticate**

## CLI flags and environment variables

`packages/mcp/README.md` → section **CLI** (flag table)
`packages/mcp/README.md` → section **Environment variables**

## Capability schema (all valid cap values)

`packages/mcp/src/config.ts` → `CapabilitySchema`

## Programmatic API

`packages/mcp/README.md` → section **Programmatic API**

## MCP Prompts (canned workflows)

`packages/mcp/src/prompts/index.ts` → `registerPrompts()`

## MCP Resources (URI schemes)

`packages/mcp/src/resources/index.ts` → `registerResources()`
`packages/mcp/README.md` → section **Resources & prompts**

## Tool registry and capability gating

`packages/mcp/src/registry/index.ts` → `ToolRegistry.register()` and `ToolContext.bootstrap`

## Token-budget truncation

`packages/mcp/src/registry/index.ts` → `truncateToTokens` call in `wrapped`
`packages/mcp/src/telemetry/tokens.ts` → `truncateToTokens`

## Deprecated aliases

`packages/mcp/src/registry/index.ts` → `for (const alias of def.aliases ?? [])`

## Bootstrap endpoint

`packages/mcp/src/index.ts` → bootstrap block (lines ~79–92)
`cloud-platform-app/server/src/services/mcp-bootstrap.service.ts`

## Transport implementations

`packages/mcp/src/transport/stdio.ts`
`packages/mcp/src/transport/http.ts`

## Mock server (for development without a live account)

`packages/mcp/README.md` → section **Quick start** (mock variant)
`CLAUDE.md` → section **How to run locally**
