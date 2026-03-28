# testrelic-mcp-server / tests

Test suites for the TestRelic MCP (Model Context Protocol) server.

## Planned Test Coverage

- `unit/` — Unit tests for individual MCP tools and handlers
- `integration/` — Integration tests for MCP tool calls against the mock server

## Running Tests

```bash
# Install dependencies
npm install

# Start mock server
npm run mock

# Run tests (once added)
npm test
```

## Testing Strategy

The MCP server can be tested against the mock server (`mock-server/`) which simulates the TestRelic API without needing a live backend.
