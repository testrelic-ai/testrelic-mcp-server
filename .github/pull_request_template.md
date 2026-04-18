## What this PR does

<!-- Short description of the change and why. -->

## Marketplace / security checklist

- [ ] No credentials, tokens, or `.env` files are committed.
- [ ] No new outbound network calls were added to the MCP — all upstreams
      still go through `cloud-platform-app`.
- [ ] No binaries, compiled artefacts, or remote-fetched scripts are
      added to the plugin surface (manifest, `mcp.json`, `assets/`).
- [ ] If environment variables changed: [.env.example](../.env.example)
      and [README.md](../README.md) are updated.
- [ ] If `.cursor-plugin/plugin.json` or `mcp.json` changed: I validated
      the plugin by symlinking it into `~/.cursor/plugins/local/testrelic-mcp`
      and loading it in Cursor.
- [ ] `npm run typecheck` and `npm run test` pass locally.
- [ ] `npm run roll` produced no uncommitted diffs.

## Notes for marketplace reviewers

<!-- Optional: anything a Cursor marketplace reviewer should know about
     this change (new tools, changed MCP config, changed auth flow). -->
