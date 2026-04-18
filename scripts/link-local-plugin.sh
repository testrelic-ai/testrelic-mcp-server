#!/usr/bin/env bash
# Preview this repository as a Cursor plugin locally on macOS / Linux.
#
# Usage (from the repo root):
#   ./scripts/link-local-plugin.sh
#
# The script:
#   1. Symlinks the repo to ~/.cursor/plugins/local/testrelic-mcp
#   2. Writes an mcp.json with an ABSOLUTE path to packages/mcp/dist/cli.js
#      because Cursor resolves relative paths from $HOME, not the plugin dir.
#   3. Prints instructions for restarting Cursor.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_dir="$HOME/.cursor/plugins/local"
link_path="$plugin_dir/testrelic-mcp"

mkdir -p "$plugin_dir"

if [[ -L "$link_path" || -e "$link_path" ]]; then
  echo "Removing existing entry at $link_path"
  rm -rf "$link_path"
fi

ln -s "$repo_root" "$link_path"
echo "Linked $link_path -> $repo_root"

# Write an mcp.json with an absolute path to cli.js.
# Cursor does NOT set cwd to the plugin directory, so relative paths in
# mcp.json resolve from $HOME. The absolute path sidesteps this.
cli_path="$link_path/packages/mcp/dist/cli.js"
cat > "$link_path/mcp.json" <<EOF
{
  "mcpServers": {
    "testrelic": {
      "command": "node",
      "args": [
        "$cli_path",
        "--caps",
        "core,coverage,creation,healing,impact",
        "--mock-mode"
      ],
      "env": {}
    }
  }
}
EOF
echo "Wrote absolute-path mcp.json to $link_path"
echo ""
echo "Next steps:"
echo "  1. FULLY close and reopen Cursor (not just 'Developer: Reload Window')."
echo "  2. Open Settings -> Features -> Model Context Protocol."
echo "  3. Confirm a 'testrelic' server is listed and enabled (green dot)."
echo "  4. In the agent, ask: 'call tr_health' -- it should succeed in"
echo "     mock mode without any environment variables."
