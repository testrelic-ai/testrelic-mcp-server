# Preview this repository as a Cursor plugin locally.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/link-local-plugin.ps1
#
# The script:
#   1. Copies/symlinks the repo to ~/.cursor/plugins/local/testrelic-mcp
#   2. Writes an mcp.json with an ABSOLUTE path to packages/mcp/dist/cli.js
#      because Cursor resolves relative paths from %USERPROFILE%, not the
#      plugin directory.
#   3. Prints instructions for restarting Cursor.

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pluginLocalDir = Join-Path $env:USERPROFILE '.cursor\plugins\local'
$linkPath = Join-Path $pluginLocalDir 'testrelic-mcp'

if (-not (Test-Path $pluginLocalDir)) {
    New-Item -ItemType Directory -Path $pluginLocalDir | Out-Null
}

if (Test-Path $linkPath) {
    Write-Host "Removing existing entry at $linkPath" -ForegroundColor Yellow
    Remove-Item -Recurse -Force $linkPath
}

$linked = $false
try {
    New-Item -ItemType SymbolicLink -Path $linkPath -Target $repoRoot | Out-Null
    $linked = $true
    Write-Host "Linked $linkPath -> $repoRoot" -ForegroundColor Green
} catch {
    Write-Host "Symlink failed (requires Developer Mode or admin on Windows)." -ForegroundColor Red
    Write-Host "Falling back to a directory copy. Re-run this script after edits." -ForegroundColor Yellow

    New-Item -ItemType Directory -Path $linkPath | Out-Null

    $exclude = @(
        'node_modules',
        'dist',
        '.git',
        '.testrelic-cache',
        '.testrelic-cache-test',
        '.testrelic-output',
        '.testrelic-output-test',
        'coverage',
        '.env'
    )

    Get-ChildItem -Force -Path $repoRoot | Where-Object {
        -not ($exclude -contains $_.Name)
    } | ForEach-Object {
        Copy-Item -Recurse -Force -Path $_.FullName -Destination (Join-Path $linkPath $_.Name)
    }
}

# Write mcp.json pointing to the live stage MCP server (streamable HTTP transport).
# Cursor auto-detects the protocol from the server response — no local binary needed.
$mcpJson = @"
{
  "mcpServers": {
    "testrelic": {
      "url": "https://mcp-stage.testrelic.ai/mcp"
    }
  }
}
"@
$mcpJson | Set-Content -Encoding UTF8 (Join-Path $linkPath 'mcp.json')
Write-Host "Wrote remote-URL mcp.json to $linkPath" -ForegroundColor Green

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. FULLY close and reopen Cursor (File -> Exit, not just Reload Window).'
Write-Host '  2. Open Settings -> Features -> Model Context Protocol.'
Write-Host '  3. Confirm a "testrelic" server is listed and enabled (green dot).'
Write-Host '  4. In the agent, ask: "list the available TestRelic tools" to verify.'

if (-not $linked) {
    Write-Host ''
    Write-Host 'Note: used directory copy (no symlink). Re-run this script after editing plugin files.' -ForegroundColor Yellow
}
