import type { LokiQueryResponse } from "../../packages/mcp/src/types/index.js";

export const mockLokiResponses: Record<string, LokiQueryResponse> = {
  "checkout_payment_failed": {
    query: "checkout_payment_failed",
    time_range: "2026-02-28T13:50:00Z to 2026-02-28T14:10:00Z",
    error_rate_peak: 0.12,
    peak_time: "2026-02-28T14:03:00Z",
    total_errors: 347,
    log_lines: [
      {
        timestamp: "2026-02-28T14:02:48Z",
        level: "WARN",
        service: "payment-gateway",
        message: "Gateway latency elevated: p99=4823ms threshold=2000ms",
        error_rate: 0.02,
      },
      {
        timestamp: "2026-02-28T14:02:55Z",
        level: "ERROR",
        service: "payment-gateway",
        message: "Gateway timeout after 5000ms — upstream: stripe-proxy",
        error_rate: 0.05,
      },
      {
        timestamp: "2026-02-28T14:03:00Z",
        level: "ERROR",
        service: "checkout-api",
        message: "PaymentService.processPayment timeout: stripe response exceeded SLA",
        error_rate: 0.12,
      },
      {
        timestamp: "2026-02-28T14:03:01Z",
        level: "ERROR",
        service: "checkout-api",
        message: "Retry 1/3 failed for order #78342 — payment gateway 504",
        error_rate: 0.12,
      },
      {
        timestamp: "2026-02-28T14:03:03Z",
        level: "ERROR",
        service: "checkout-api",
        message: "Retry 2/3 failed for order #78342 — payment gateway 504",
        error_rate: 0.12,
      },
      {
        timestamp: "2026-02-28T14:03:07Z",
        level: "ERROR",
        service: "checkout-api",
        message: "All retries exhausted for order #78342. Returning error to client.",
        error_rate: 0.12,
      },
      {
        timestamp: "2026-02-28T14:04:30Z",
        level: "WARN",
        service: "payment-gateway",
        message: "Gateway latency returning to normal: p99=312ms",
        error_rate: 0.04,
      },
      {
        timestamp: "2026-02-28T14:05:10Z",
        level: "INFO",
        service: "payment-gateway",
        message: "Gateway fully recovered. Error rate nominal.",
        error_rate: 0.01,
      },
    ],
  },

  "auth_login_failed": {
    query: "auth_login_failed",
    time_range: "2026-02-28T14:50:00Z to 2026-02-28T15:10:00Z",
    error_rate_peak: 0.04,
    peak_time: "2026-02-28T15:01:00Z",
    total_errors: 89,
    log_lines: [
      {
        timestamp: "2026-02-28T15:00:45Z",
        level: "ERROR",
        service: "auth-service",
        message: "Session store connection pool exhausted: redis pool=10/10",
        error_rate: 0.03,
      },
      {
        timestamp: "2026-02-28T15:01:00Z",
        level: "ERROR",
        service: "auth-service",
        message: "Login failed: unable to create session — redis timeout 500ms",
        error_rate: 0.04,
      },
    ],
  },

  "api_products_503": {
    query: "api_products_503",
    time_range: "2026-02-27T09:50:00Z to 2026-02-27T10:10:00Z",
    error_rate_peak: 0.31,
    peak_time: "2026-02-27T10:01:00Z",
    total_errors: 521,
    log_lines: [
      {
        timestamp: "2026-02-27T10:00:50Z",
        level: "ERROR",
        service: "product-catalog",
        message: "Database connection refused: postgres replica-1 unreachable",
        error_rate: 0.31,
      },
      {
        timestamp: "2026-02-27T10:01:00Z",
        level: "ERROR",
        service: "product-catalog",
        message: "Fallback to replica-2 also failed. Returning 503.",
        error_rate: 0.31,
      },
    ],
  },
};
