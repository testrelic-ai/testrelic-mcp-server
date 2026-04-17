import type { RunFailuresResponse } from "../../packages/mcp/src/types/index.js";

export const mockFailures: Record<string, RunFailuresResponse> = {
  "RUN-2847": {
    run_id: "RUN-2847",
    failures: [
      {
        test_id: "TEST-checkout-001",
        test_name: "Checkout > Payment > completes purchase with valid card",
        suite: "checkout",
        error_type: "TimeoutError",
        error_message:
          "Timeout 30000ms exceeded waiting for element to be visible: [data-testid='payment-success-banner']",
        stack_trace: `TimeoutError: Timeout 30000ms exceeded.
  at checkout_api.ts:142:18
  at PaymentService.processPayment (payment-service.ts:89:12)
  at CheckoutPage.submitOrder (checkout-page.ts:234:8)
  at Object.<anonymous> (checkout.spec.ts:67:5)`,
        duration_ms: 30142,
        retry_count: 2,
        video_url: "https://storage.testrelic.ai/videos/RUN-2847/TEST-checkout-001.webm",
        video_timestamp_ms: 28340,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2847/TEST-checkout-001-fail.png",
      },
      {
        test_id: "TEST-checkout-002",
        test_name: "Checkout > Payment > retries on transient gateway error",
        suite: "checkout",
        error_type: "TimeoutError",
        error_message: "Timeout 30000ms exceeded. Gateway returned 504 after 3 retries.",
        stack_trace: `TimeoutError: Timeout 30000ms exceeded.
  at checkout_api.ts:187:22
  at GatewayClient.retry (gateway-client.ts:54:9)
  at PaymentService.processPayment (payment-service.ts:102:14)
  at checkout.spec.ts:89:5`,
        duration_ms: 30214,
        retry_count: 2,
        video_url: "https://storage.testrelic.ai/videos/RUN-2847/TEST-checkout-002.webm",
        video_timestamp_ms: 29100,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2847/TEST-checkout-002-fail.png",
      },
      {
        test_id: "TEST-checkout-003",
        test_name: "Checkout > Summary > shows correct order total with tax",
        suite: "checkout",
        error_type: "AssertionError",
        error_message: "Expected '$127.43' to equal '$124.99'. Tax calculation mismatch.",
        stack_trace: `AssertionError: Expected '$127.43' to equal '$124.99'.
  at expect (checkout.spec.ts:114:18)
  at OrderSummary.verifyTotal (order-summary.ts:67:5)
  at checkout.spec.ts:112:5`,
        duration_ms: 4320,
        retry_count: 0,
        video_url: "https://storage.testrelic.ai/videos/RUN-2847/TEST-checkout-003.webm",
        video_timestamp_ms: 4100,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2847/TEST-checkout-003-fail.png",
      },
      {
        test_id: "TEST-checkout-004",
        test_name: "Checkout > Shipping > applies promo code discount",
        suite: "checkout",
        error_type: "TimeoutError",
        error_message:
          "Timeout 30000ms exceeded waiting for response from /api/promo/validate",
        stack_trace: `TimeoutError: Timeout 30000ms exceeded.
  at checkout_api.ts:223:10
  at PromoService.validate (promo-service.ts:31:8)
  at checkout.spec.ts:145:5`,
        duration_ms: 30091,
        retry_count: 1,
        video_url: "https://storage.testrelic.ai/videos/RUN-2847/TEST-checkout-004.webm",
        video_timestamp_ms: 29800,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2847/TEST-checkout-004-fail.png",
      },
      {
        test_id: "TEST-cart-001",
        test_name: "Cart > updates quantity and recalculates total",
        suite: "cart",
        error_type: "NetworkError",
        error_message: "Failed to fetch: /api/cart/update — net::ERR_CONNECTION_RESET",
        stack_trace: `NetworkError: Failed to fetch /api/cart/update.
  at CartService.updateItem (cart-service.ts:78:11)
  at CartPage.changeQuantity (cart-page.ts:156:7)
  at cart.spec.ts:43:5`,
        duration_ms: 8120,
        retry_count: 1,
        video_url: "https://storage.testrelic.ai/videos/RUN-2847/TEST-cart-001.webm",
        video_timestamp_ms: 7890,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2847/TEST-cart-001-fail.png",
      },
    ],
  },

  "RUN-2849": {
    run_id: "RUN-2849",
    failures: [
      {
        test_id: "TEST-auth-001",
        test_name: "Auth > Login > redirects to dashboard after successful login",
        suite: "auth",
        error_type: "NavigationError",
        error_message: "Navigation timeout 15000ms exceeded. Expected URL to contain '/dashboard'.",
        stack_trace: `NavigationError: Timeout 15000ms exceeded navigating to /dashboard.
  at auth-page.ts:89:14
  at AuthService.login (auth-service.ts:42:9)
  at auth.spec.ts:28:5`,
        duration_ms: 15123,
        retry_count: 1,
        video_url: "https://storage.testrelic.ai/videos/RUN-2849/TEST-auth-001.webm",
        video_timestamp_ms: 14900,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2849/TEST-auth-001-fail.png",
      },
      {
        test_id: "TEST-search-001",
        test_name: "Search > returns results for partial product name",
        suite: "search",
        error_type: "AssertionError",
        error_message: "Expected 12 results, received 0. Search index may be stale.",
        stack_trace: `AssertionError: Expected 12 results, received 0.
  at search.spec.ts:56:18
  at SearchPage.getResultCount (search-page.ts:34:5)
  at search.spec.ts:54:5`,
        duration_ms: 3210,
        retry_count: 0,
        video_url: "https://storage.testrelic.ai/videos/RUN-2849/TEST-search-001.webm",
        video_timestamp_ms: 3000,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2849/TEST-search-001-fail.png",
      },
    ],
  },

  "RUN-2845": {
    run_id: "RUN-2845",
    failures: [
      {
        test_id: "TEST-checkout-001",
        test_name: "Checkout > Payment > completes purchase with valid card",
        suite: "checkout",
        error_type: "TimeoutError",
        error_message:
          "Timeout 30000ms exceeded waiting for element to be visible: [data-testid='payment-success-banner']",
        stack_trace: `TimeoutError: Timeout 30000ms exceeded.
  at checkout_api.ts:142:18
  at PaymentService.processPayment (payment-service.ts:89:12)
  at checkout.spec.ts:67:5`,
        duration_ms: 30142,
        retry_count: 2,
        video_url: "https://storage.testrelic.ai/videos/RUN-2845/TEST-checkout-001.webm",
        video_timestamp_ms: 28340,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2845/TEST-checkout-001-fail.png",
      },
    ],
  },

  "RUN-2843": {
    run_id: "RUN-2843",
    failures: [
      {
        test_id: "TEST-api-001",
        test_name: "API > Products > GET /products returns paginated list",
        suite: "api",
        error_type: "AssertionError",
        error_message: "Expected status 200, received 503. Service unavailable.",
        stack_trace: `AssertionError: Expected status 200, received 503.
  at api.spec.ts:34:18
  at ProductsAPI.list (products-api.ts:22:5)
  at api.spec.ts:32:5`,
        duration_ms: 5420,
        retry_count: 2,
        video_url: "",
        video_timestamp_ms: 0,
        screenshot_url: "",
      },
    ],
  },

  "RUN-2840": {
    run_id: "RUN-2840",
    failures: [
      {
        test_id: "TEST-checkout-001",
        test_name: "Checkout > Payment > completes purchase with valid card",
        suite: "checkout",
        error_type: "TimeoutError",
        error_message: "Timeout 30000ms exceeded.",
        stack_trace: `TimeoutError: Timeout 30000ms exceeded.
  at checkout_api.ts:142:18
  at PaymentService.processPayment (payment-service.ts:89:12)
  at checkout.spec.ts:67:5`,
        duration_ms: 30142,
        retry_count: 2,
        video_url: "https://storage.testrelic.ai/videos/RUN-2840/TEST-checkout-001.webm",
        video_timestamp_ms: 28340,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2840/TEST-checkout-001-fail.png",
      },
      {
        test_id: "TEST-profile-001",
        test_name: "Profile > User can update avatar image",
        suite: "profile",
        error_type: "UploadError",
        error_message: "File upload failed: /api/user/avatar — 413 Payload Too Large",
        stack_trace: `UploadError: 413 Payload Too Large at /api/user/avatar
  at profile-page.ts:112:9
  at ProfileService.updateAvatar (profile-service.ts:44:7)
  at profile.spec.ts:29:5`,
        duration_ms: 2890,
        retry_count: 0,
        video_url: "https://storage.testrelic.ai/videos/RUN-2840/TEST-profile-001.webm",
        video_timestamp_ms: 2700,
        screenshot_url:
          "https://storage.testrelic.ai/screenshots/RUN-2840/TEST-profile-001-fail.png",
      },
    ],
  },
};
