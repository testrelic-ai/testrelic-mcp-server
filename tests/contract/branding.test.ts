import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_TOOLS } from "../../packages/mcp/src/tools/index.js";

/**
 * Branding lint.
 *
 * The dynamic-Apps gateway brand name must never appear in any user-facing
 * MCP surface — tool names, descriptions, output schemas, generated README
 * tables, mock fixtures, prompt definitions, or resource URIs. The disallow
 * list is held inline (not in the plan or in any file the gateway brand is
 * meant to be absent from) so future contributors see the failure immediately.
 *
 * Why this lint exists: the platform's internal service file that fronts the
 * gateway keeps its current name, but the controller boundary
 * (`mcp-apps.controller.ts`) renames every outgoing field. This test asserts
 * that the rename held on the MCP-server side too.
 */

// Lowercase substrings that must not appear in user-facing strings.
// Add brand names of any future third-party action-gateway here.
const DISALLOWED_SUBSTRINGS = ["composio"];

function assertNoDisallowed(label: string, text: string | undefined | null): void {
  if (!text) return;
  const lower = text.toLowerCase();
  for (const needle of DISALLOWED_SUBSTRINGS) {
    expect(lower.includes(needle), `[${label}] contains disallowed substring "${needle}": ${text.slice(0, 200)}`).toBe(false);
  }
}

describe("branding: user-facing MCP surface", () => {
  it("no tool name, title, or description contains a disallowed gateway brand", () => {
    for (const t of ALL_TOOLS) {
      assertNoDisallowed(`tool name (${t.name})`, t.name);
      assertNoDisallowed(`tool title (${t.name})`, t.title);
      assertNoDisallowed(`tool description (${t.name})`, t.description);
      for (const a of t.aliases ?? []) {
        assertNoDisallowed(`alias name (${a.name})`, a.name);
        assertNoDisallowed(`alias description (${a.name})`, a.description);
      }
    }
  });

  it("no tool input/output schema field name contains a disallowed gateway brand", () => {
    for (const t of ALL_TOOLS) {
      for (const key of Object.keys(t.inputSchema)) {
        assertNoDisallowed(`${t.name} inputSchema key`, key);
      }
      if (t.outputSchema) {
        for (const key of Object.keys(t.outputSchema)) {
          assertNoDisallowed(`${t.name} outputSchema key`, key);
        }
      }
    }
  });

  it("regenerated README contains no disallowed gateway brand", () => {
    const readmePath = resolve(__dirname, "../../packages/mcp/README.md");
    if (!existsSync(readmePath)) return; // First run before `npm run roll` is fine.
    const text = readFileSync(readmePath, "utf-8");
    assertNoDisallowed("packages/mcp/README.md", text);
  });

  it("mock-server fixtures contain no disallowed gateway brand", () => {
    const cloudRoutes = resolve(__dirname, "../../mock-server/routes/cloud.ts");
    if (existsSync(cloudRoutes)) {
      assertNoDisallowed("mock-server/routes/cloud.ts", readFileSync(cloudRoutes, "utf-8"));
    }
    const appsCatalog = resolve(__dirname, "../../mock-server/data/apps-catalog.json");
    if (existsSync(appsCatalog)) {
      assertNoDisallowed("mock-server/data/apps-catalog.json", readFileSync(appsCatalog, "utf-8"));
    }
  });
});
