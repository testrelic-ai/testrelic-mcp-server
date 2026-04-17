/**
 * Test framework templates. These are the "skeleton" for tr_generate_test to
 * fill in via sampling. Kept minimal and battle-tested; each template should
 * compile on its own when the steps array is stripped.
 */

export interface FrameworkTemplate {
  framework: "playwright" | "cypress" | "jest" | "vitest";
  extension: string;
  description: string;
  skeleton: (opts: { testName: string; steps: string[]; imports?: string[] }) => string;
}

export const TEMPLATES: Record<string, FrameworkTemplate> = {
  playwright: {
    framework: "playwright",
    extension: ".spec.ts",
    description: "Playwright Test with Chromium, web-first assertions, and built-in auto-waits.",
    skeleton: ({ testName, steps, imports = [] }) => `import { test, expect } from "@playwright/test";
${imports.join("\n")}

test("${escapeQuotes(testName)}", async ({ page }) => {
${steps.map((s) => `  ${s}`).join("\n")}
});
`,
  },
  cypress: {
    framework: "cypress",
    extension: ".cy.ts",
    description: "Cypress e2e spec. Uses the describe/it convention.",
    skeleton: ({ testName, steps, imports = [] }) => `${imports.join("\n")}

describe("${escapeQuotes(testName)}", () => {
  it("covers the journey", () => {
${steps.map((s) => `    ${s}`).join("\n")}
  });
});
`,
  },
  jest: {
    framework: "jest",
    extension: ".test.ts",
    description: "Jest unit test. Assumes testing-library where relevant.",
    skeleton: ({ testName, steps, imports = [] }) => `${imports.join("\n")}

describe("${escapeQuotes(testName)}", () => {
  it("behaves as expected", async () => {
${steps.map((s) => `    ${s}`).join("\n")}
  });
});
`,
  },
  vitest: {
    framework: "vitest",
    extension: ".test.ts",
    description: "Vitest spec — drop-in compatible with Jest assertions.",
    skeleton: ({ testName, steps, imports = [] }) => `import { describe, it, expect } from "vitest";
${imports.join("\n")}

describe("${escapeQuotes(testName)}", () => {
  it("behaves as expected", async () => {
${steps.map((s) => `    ${s}`).join("\n")}
  });
});
`,
  },
};

function escapeQuotes(s: string): string {
  return s.replace(/"/g, '\\"');
}
