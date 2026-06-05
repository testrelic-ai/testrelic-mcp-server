/**
 * Frameworks selectable when FILTERING existing runs (tr_recent_runs /
 * tr_list_runs and the run-scoped prompt). Kept in one place so these run-filter
 * enums stay in sync with each other and with the platform's ingestion
 * allow-list — `pytest` is the dominant (often only) framework present in the
 * data, yet was previously unselectable. TEAI-229.
 *
 * This is deliberately DISTINCT from the JS test-GENERATION frameworks used by
 * the creation / healing tools (which emit Playwright/Cypress/Jest/Vitest code
 * and cannot generate pytest), so those enums intentionally do not import this.
 */
export const RUN_FILTER_FRAMEWORKS = [
  "playwright",
  "cypress",
  "jest",
  "vitest",
  "pytest",
] as const;
