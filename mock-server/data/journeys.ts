import type { UserJourney, TestCoverageEntry, CodeNode, CoverageReport, CoverageGap } from "../../packages/mcp/src/types/index.js";

/**
 * v2 fixtures — Amplitude-derived journey catalog, test-to-journey coverage
 * map, code node index, and pre-computed coverage report. Designed so a
 * local agent can exercise the full coverage workflow end-to-end.
 *
 * These fixtures are deliberately under-covered (user_coverage ≈ 0.67) so
 * the agent has real gaps to close via tr_plan_test → tr_generate_test.
 */

export const mockJourneys: Record<string, UserJourney[]> = {
  "PROJ-1": [
    {
      id: "J-CHECKOUT-GUEST",
      project_id: "PROJ-1",
      name: "Guest checkout — card",
      events: ["view_cart", "start_checkout", "enter_shipping", "enter_payment", "submit_order", "view_receipt"],
      user_count: 48_217,
      session_count: 62_310,
      critical_props: ["cart_total_usd", "payment_method"],
      last_seen: "2026-04-17T05:12:00Z",
    },
    {
      id: "J-CHECKOUT-SAVED",
      project_id: "PROJ-1",
      name: "Returning checkout — saved card",
      events: ["view_cart", "start_checkout", "confirm_address", "submit_order", "view_receipt"],
      user_count: 36_045,
      session_count: 54_902,
      critical_props: ["saved_card_id"],
      last_seen: "2026-04-17T05:10:00Z",
    },
    {
      id: "J-SEARCH-PDP",
      project_id: "PROJ-1",
      name: "Search → PDP → add-to-cart",
      events: ["search", "view_search_results", "view_pdp", "add_to_cart"],
      user_count: 124_811,
      session_count: 211_300,
      last_seen: "2026-04-17T05:13:00Z",
    },
    {
      id: "J-WISHLIST-SHARE",
      project_id: "PROJ-1",
      name: "Wishlist share (uncovered)",
      events: ["view_pdp", "add_to_wishlist", "share_wishlist"],
      user_count: 12_440,
      session_count: 14_112,
      last_seen: "2026-04-16T22:20:00Z",
    },
    {
      id: "J-REFUND-SELF",
      project_id: "PROJ-1",
      name: "Self-service refund (uncovered)",
      events: ["view_order_history", "open_order", "request_refund", "confirm_refund"],
      user_count: 7_902,
      session_count: 8_614,
      last_seen: "2026-04-17T02:05:00Z",
    },
    {
      id: "J-INTL-CHECKOUT",
      project_id: "PROJ-1",
      name: "International checkout (uncovered)",
      events: ["view_cart", "start_checkout", "enter_shipping", "choose_customs", "enter_payment", "submit_order"],
      user_count: 5_311,
      session_count: 5_998,
      last_seen: "2026-04-16T19:40:00Z",
    },
    {
      id: "J-GIFT-CARD",
      project_id: "PROJ-1",
      name: "Gift card redemption (uncovered)",
      events: ["view_cart", "apply_gift_card", "submit_order"],
      user_count: 3_760,
      session_count: 4_112,
      last_seen: "2026-04-16T11:08:00Z",
    },
    {
      id: "J-APPLE-PAY",
      project_id: "PROJ-1",
      name: "Apple Pay checkout",
      events: ["view_cart", "start_checkout", "apple_pay_submit", "view_receipt"],
      user_count: 18_450,
      session_count: 19_800,
      last_seen: "2026-04-17T04:55:00Z",
    },
  ],
  "PROJ-2": [
    {
      id: "J-API-LOGIN",
      project_id: "PROJ-2",
      name: "Mobile API login",
      events: ["app_open", "api_login", "api_fetch_profile"],
      user_count: 81_002,
      session_count: 104_551,
      last_seen: "2026-04-17T05:11:00Z",
    },
    {
      id: "J-API-ORDER",
      project_id: "PROJ-2",
      name: "Mobile order placement",
      events: ["app_open", "api_login", "api_browse", "api_place_order"],
      user_count: 44_212,
      session_count: 50_110,
      last_seen: "2026-04-17T05:05:00Z",
    },
  ],
};

export const mockTestMap: Record<string, TestCoverageEntry[]> = {
  "PROJ-1": [
    {
      test_id: "T-CHECKOUT-HAPPY",
      test_name: "guest checkout — happy path",
      suite: "checkout",
      project_id: "PROJ-1",
      journey_ids: ["J-CHECKOUT-GUEST"],
      code_node_ids: ["src/checkout/api.ts:pay:42", "src/checkout/ui.ts:SubmitButton:12"],
      tags: ["@journey:checkout-guest", "@event:submit_order"],
      source_file: "tests/checkout.spec.ts",
    },
    {
      test_id: "T-CHECKOUT-SAVED",
      test_name: "returning user saved card",
      suite: "checkout",
      project_id: "PROJ-1",
      journey_ids: ["J-CHECKOUT-SAVED"],
      code_node_ids: ["src/checkout/api.ts:payWithSaved:88"],
      tags: ["@journey:checkout-saved"],
      source_file: "tests/checkout-saved.spec.ts",
    },
    {
      test_id: "T-SEARCH-ATC",
      test_name: "search and add to cart",
      suite: "search",
      project_id: "PROJ-1",
      journey_ids: ["J-SEARCH-PDP"],
      code_node_ids: ["src/search/index.ts:handleSearch:55", "src/cart/add.ts:add:22"],
      tags: ["@journey:search-pdp"],
      source_file: "tests/search.spec.ts",
    },
    {
      test_id: "T-APPLE-PAY",
      test_name: "apple pay happy path",
      suite: "checkout",
      project_id: "PROJ-1",
      journey_ids: ["J-APPLE-PAY"],
      code_node_ids: ["src/checkout/apple-pay.ts:submit:18"],
      tags: ["@journey:apple-pay"],
      source_file: "tests/apple-pay.spec.ts",
    },
    {
      test_id: "T-PDP-VIEW",
      test_name: "pdp renders product details",
      suite: "catalog",
      project_id: "PROJ-1",
      journey_ids: ["J-SEARCH-PDP"],
      code_node_ids: ["src/catalog/pdp.tsx:ProductDetail:100"],
      tags: ["@journey:search-pdp", "@event:view_pdp"],
      source_file: "tests/pdp.spec.ts",
    },
  ],
  "PROJ-2": [
    {
      test_id: "T-API-LOGIN-OK",
      test_name: "mobile login returns session",
      suite: "api",
      project_id: "PROJ-2",
      journey_ids: ["J-API-LOGIN"],
      code_node_ids: ["src/api/login.ts:handleLogin:14"],
      source_file: "tests/api-login.spec.ts",
    },
  ],
};

export const mockCodeMap: Record<string, CodeNode[]> = {
  "PROJ-1": [
    { id: "src/checkout/api.ts:pay:42", file: "src/checkout/api.ts", name: "pay", kind: "function", start_line: 42, end_line: 72 },
    { id: "src/checkout/api.ts:payWithSaved:88", file: "src/checkout/api.ts", name: "payWithSaved", kind: "function", start_line: 88, end_line: 110 },
    { id: "src/checkout/api.ts:applyGiftCard:130", file: "src/checkout/api.ts", name: "applyGiftCard", kind: "function", start_line: 130, end_line: 162 },
    { id: "src/checkout/apple-pay.ts:submit:18", file: "src/checkout/apple-pay.ts", name: "submit", kind: "function", start_line: 18, end_line: 40 },
    { id: "src/checkout/ui.ts:SubmitButton:12", file: "src/checkout/ui.ts", name: "SubmitButton", kind: "function", start_line: 12, end_line: 24 },
    { id: "src/search/index.ts:handleSearch:55", file: "src/search/index.ts", name: "handleSearch", kind: "function", start_line: 55, end_line: 88 },
    { id: "src/cart/add.ts:add:22", file: "src/cart/add.ts", name: "add", kind: "function", start_line: 22, end_line: 40 },
    { id: "src/catalog/pdp.tsx:ProductDetail:100", file: "src/catalog/pdp.tsx", name: "ProductDetail", kind: "class", start_line: 100, end_line: 220 },
    { id: "src/refund/index.ts:requestRefund:10", file: "src/refund/index.ts", name: "requestRefund", kind: "function", start_line: 10, end_line: 42 },
    { id: "src/wishlist/share.ts:share:8", file: "src/wishlist/share.ts", name: "share", kind: "function", start_line: 8, end_line: 28 },
  ],
  "PROJ-2": [
    { id: "src/api/login.ts:handleLogin:14", file: "src/api/login.ts", name: "handleLogin", kind: "function", start_line: 14, end_line: 58 },
    { id: "src/api/order.ts:placeOrder:20", file: "src/api/order.ts", name: "placeOrder", kind: "function", start_line: 20, end_line: 64 },
  ],
};

export function computeCoverageReport(project_id: string): CoverageReport {
  const journeys = mockJourneys[project_id] ?? [];
  const tests = mockTestMap[project_id] ?? [];
  const codeMap = mockCodeMap[project_id] ?? [];
  const coveredJourneys = new Set<string>();
  const coveredNodes = new Set<string>();
  for (const t of tests) {
    for (const j of t.journey_ids) coveredJourneys.add(j);
    for (const n of t.code_node_ids) coveredNodes.add(n);
  }
  const uncovered = journeys.filter((j) => !coveredJourneys.has(j.id));
  return {
    project_id,
    generated_at: new Date().toISOString(),
    user_coverage: journeys.length > 0 ? (journeys.length - uncovered.length) / journeys.length : 0,
    test_coverage: codeMap.length > 0 ? coveredNodes.size / codeMap.length : 0,
    total_journeys: journeys.length,
    covered_journeys: journeys.length - uncovered.length,
    uncovered_journeys: uncovered.length,
    total_code_nodes: codeMap.length,
    covered_code_nodes: coveredNodes.size,
    gaps_summary: uncovered.slice(0, 5).map((j) => ({
      journey_id: j.id,
      user_count: j.user_count,
      reason: j.events.join(" → "),
    })),
  };
}

export function computeCoverageGaps(project_id: string, limit = 10): CoverageGap[] {
  const journeys = mockJourneys[project_id] ?? [];
  const tests = mockTestMap[project_id] ?? [];
  const covered = new Set<string>();
  for (const t of tests) for (const j of t.journey_ids) covered.add(j);
  const totalUsers = journeys.reduce((s, j) => s + j.user_count, 0) || 1;
  return journeys
    .filter((j) => !covered.has(j.id))
    .sort((a, b) => b.user_count - a.user_count)
    .slice(0, limit)
    .map<CoverageGap>((j) => ({
      journey_id: j.id,
      journey_name: j.name,
      user_count: j.user_count,
      session_count: j.session_count,
      events: j.events,
      pp_coverage_gain: (j.user_count / totalUsers) * 100,
    }));
}

/** Very small test-source fixtures for healing/generation demos. */
export const mockTestSource: Record<string, { source: string; file: string }> = {
  "T-CHECKOUT-HAPPY": {
    file: "tests/checkout.spec.ts",
    source: `import { test, expect } from "@playwright/test";

test("guest checkout — happy path", async ({ page }) => {
  await page.goto("/cart");
  await page.locator(".btn-checkout").click();
  await page.fill("#email", "buyer@example.com");
  await page.fill("#card_number", "4242424242424242");
  await page.locator(".btn-submit").click();
  await expect(page).toHaveURL(/receipt/);
});
`,
  },
};
