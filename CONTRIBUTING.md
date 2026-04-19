# Contributing to TestRelic MCP

Thanks for your interest in improving the TestRelic Model Context
Protocol server. This plugin is listed in the Cursor Marketplace, so
contributions are reviewed with both code quality and marketplace
security in mind.

## Ground rules

- All contributions are licensed under **AGPL-3.0-only**, the same licence
  as the project (see [LICENSE](LICENSE)).
- By opening a pull request you confirm you have the right to contribute
  the code under this licence.
- Be kind. We follow the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## Where to start

- Small bug fixes and docs improvements: open a PR directly.
- Behavioural changes, new tools, or changes to the manifest / `mcp.json`:
  open an issue first so we can align on the design.
- Security issues: **do not** open a public issue. Follow
  [SECURITY.md](SECURITY.md) and email `security@testrelic.ai`.

## Local development

```bash
npm install
npm run mock          # terminal 1 — mock cloud on http://localhost:4000
npm run dev           # terminal 2 — MCP server on stdio, --mock-mode
```

Useful scripts:

| Command             | Purpose                                      |
|---------------------|----------------------------------------------|
| `npm run typecheck` | Strict TypeScript typecheck across packages. |
| `npm run test`      | Full vitest suite.                           |
| `npm run ctest`     | Contract tests only.                         |
| `npm run ttest`     | Token-budget baselines.                      |
| `npm run roll`      | Regenerate tool tables and config types.     |
| `npm run format`    | Prettier over the repo.                      |

## Pull request checklist

Before requesting review, please confirm:

- [ ] `npm run typecheck` passes.
- [ ] `npm run test` passes.
- [ ] `npm run roll` produced no uncommitted diffs.
- [ ] You have **not** committed real credentials or `.env` files.
- [ ] You have **not** added outbound calls to third-party services
      from the MCP — upstreams must go through the cloud-platform-app.
- [ ] If you changed `.cursor-plugin/plugin.json` or `mcp.json`,
      you validated the plugin by symlinking it into
      `~/.cursor/plugins/local/testrelic-mcp` and loading it in Cursor.
- [ ] You have updated documentation where behaviour changed.

## Release and marketplace review

- The Cursor Marketplace reviews **every** update manually — shipping a
  new version means shipping a reviewable diff. Keep changes focused
  and well-documented.
- Do not add native binaries or remote-fetched scripts to the plugin
  surface. Runtime is always `npx @testrelic/mcp`.
- Do not add new environment variables without documenting them in
  [README.md](README.md) and updating [.env.example](.env.example).

Thanks again for contributing.
