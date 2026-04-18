# Security Policy

TestRelic maintains this repository as a public, open-source Model Context
Protocol (MCP) server distributed through the Cursor Marketplace. Security
and data handling are treated as first-class concerns.

## Supported versions

| Version | Supported |
|---------|-----------|
| `2.1.x` | Yes       |
| `2.0.x` | Security fixes only (see `packages/mcp/MIGRATION.md`) |
| `< 2.0` | No        |

## Reporting a vulnerability

Please **do not** open a public issue for security reports.

Email [security@testrelic.ai](mailto:security@testrelic.ai) with:

- A clear description of the issue and the impact.
- Steps to reproduce (a minimal repro is ideal).
- The commit SHA or released version you tested against.
- Any suggested remediation, if you have one.

You can expect:

- An acknowledgement within **2 business days**.
- A triage decision and severity within **5 business days**.
- A fix or mitigation plan within **30 days** for high-severity issues,
  faster for critical ones.

We will credit reporters in the release notes unless you request otherwise.

## Threat model for the plugin

This plugin is designed so that a Cursor Marketplace reviewer (or any
installer) can audit its risk surface in a single pass.

### What ships in this repository

- Markdown documentation, a plugin manifest (`.cursor-plugin/plugin.json`),
  an `mcp.json` descriptor, a logo asset, and the full TypeScript source
  tree for `@testrelic/mcp`.
- **No binaries.** Runtime is the pre-built `packages/mcp/dist/` TypeScript
  output bundled in this repository and launched via `node packages/mcp/dist/cli.js`.
  No package is fetched from a remote registry at install time; no remote
  scripts are executed.
- The compiled `dist/` artefacts are produced from the TypeScript source in
  `packages/mcp/src/` — both are present in the repository and can be
  cross-checked by any reviewer.
- Once `@testrelic/mcp` is published to npm, `mcp.json` will be updated to
  `npx -y @testrelic/mcp@<version>`. That will still require no secrets and
  will resolve exclusively from the public npm registry.

### What the MCP server does at runtime

- **Default marketplace posture (`--mock-mode`).** The shipped `mcp.json`
  runs the server with `--mock-mode`, which points the HTTP client at the
  in-repo mock server only. In this mode the MCP makes **zero outbound
  network calls** to third-party services.
- **Real-cloud mode (opt-in).** A user who wants real data must:
  1. Remove `--mock-mode` from their `mcp.json` (or override it).
  2. Provide a `TESTRELIC_MCP_TOKEN` (a `tr_mcp_*` personal access token)
     via env var, `--token` flag, or `~/.testrelic/token` file.
  In this mode, every outbound call goes to the configured
  `--cloud-url` (default `https://app.testrelic.ai/api/v1`) with
  `Authorization: Bearer <token>` — and nowhere else.
- **No third-party credentials on the user's machine.** Integrations
  (Amplitude, Jira, Grafana Loki, GitHub, ClickHouse) are resolved by
  the TestRelic cloud platform, not by this MCP. The legacy per-service
  env vars were removed in v2.1.

### Data handling

- The MCP writes cache and output artefacts to user-configurable
  directories (`--cache-dir`, `--output-dir`), defaulting to
  `./.testrelic-cache` and `./.testrelic-output` under the project
  root. Nothing is written outside those directories.
- Logs go to **stderr only** (never stdout) so the MCP handshake with
  the client stays intact. Log level is user-controlled via
  `--log-level`.
- No telemetry is emitted to TestRelic or any third party from this
  plugin. The `telemetry/metrics.jsonl` file is local-only.

### Honouring Cursor's MCP allowlist and blocklist

This plugin ships a single MCP server entry (`testrelic`). Cursor's
existing MCP governance (allowlist / blocklist / disable toggle in
`Settings → Features → Model Context Protocol`) applies unchanged. If
the server is disabled or blocked in a user's Cursor settings, the
plugin installs but the server cannot make calls.

## Dependency hygiene

- Runtime dependencies are pinned in `packages/mcp/package.json` with
  caret ranges and reviewed on every release.
- `optionalDependencies` (native modules such as `better-sqlite3`,
  `hnswlib-node`, `tree-sitter*`, `@xenova/transformers`) fall back to
  pure-JS equivalents at runtime. The plugin works without any native
  module installed.
- Every release is scanned with `npm audit` and GitHub Dependabot prior
  to publish.

## Reporting plugin issues to Cursor

If you believe a marketplace-listed version of this plugin is behaving
differently from this repository, please also notify
[security-reports@cursor.com](mailto:security-reports@cursor.com) per
the [Cursor Marketplace security policy](https://cursor.com/help/security-and-privacy/marketplace-security).
