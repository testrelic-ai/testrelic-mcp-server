import type { AmplitudeUserCount, AmplitudeSession } from "../../src/types/index.js";

export const mockAmplitudeUserCounts: Record<string, AmplitudeUserCount> = {
  "RUN-2847": {
    run_id: "RUN-2847",
    affected_users: 347,
    peak_time: "2026-02-28T14:03:00Z",
    error_path: "/checkout/payment",
  },
  "RUN-2849": {
    run_id: "RUN-2849",
    affected_users: 89,
    peak_time: "2026-02-28T15:01:00Z",
    error_path: "/auth/login",
  },
  "RUN-2845": {
    run_id: "RUN-2845",
    affected_users: 214,
    peak_time: "2026-02-27T18:01:30Z",
    error_path: "/checkout/payment",
  },
  "RUN-2843": {
    run_id: "RUN-2843",
    affected_users: 521,
    peak_time: "2026-02-27T10:01:00Z",
    error_path: "/api/products",
  },
  "RUN-2840": {
    run_id: "RUN-2840",
    affected_users: 678,
    peak_time: "2026-02-25T14:01:45Z",
    error_path: "/checkout/payment",
  },
};

export const mockAmplitudeSessions: Record<string, AmplitudeSession[]> = {
  "RUN-2847": [
    {
      session_id: "SESS-8f3a1c",
      user_id: "USR-10042",
      device_type: "desktop",
      country: "US",
      error_event: "checkout_payment_failed",
      occurred_at: "2026-02-28T14:03:12Z",
    },
    {
      session_id: "SESS-7b2d4e",
      user_id: "USR-20187",
      device_type: "mobile",
      country: "GB",
      error_event: "checkout_payment_failed",
      occurred_at: "2026-02-28T14:03:15Z",
    },
    {
      session_id: "SESS-6c1f5a",
      user_id: "USR-30055",
      device_type: "desktop",
      country: "CA",
      error_event: "checkout_payment_failed",
      occurred_at: "2026-02-28T14:03:21Z",
    },
    {
      session_id: "SESS-5d0e6b",
      user_id: "USR-40291",
      device_type: "tablet",
      country: "AU",
      error_event: "checkout_payment_failed",
      occurred_at: "2026-02-28T14:03:28Z",
    },
    {
      session_id: "SESS-4e9f7c",
      user_id: "USR-50134",
      device_type: "desktop",
      country: "US",
      error_event: "checkout_payment_failed",
      occurred_at: "2026-02-28T14:03:34Z",
    },
  ],
};
