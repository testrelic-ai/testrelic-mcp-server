/**
 * Error taxonomy. Every error the server throws downstream of a tool handler
 * should be one of these, so clients get machine-readable `code`.
 */

export type ErrorCode =
  | "AUTH_ERROR"
  | "UPSTREAM_ERROR"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "CACHE_MISS"
  | "CAPABILITY_DISABLED"
  | "TIMEOUT"
  | "INTERNAL"
  | "CIRCUIT_OPEN";

export class TestRelicMcpError extends Error {
  public readonly code: ErrorCode;
  public readonly service?: string;
  public readonly retriable: boolean;
  public override readonly cause?: unknown;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    service?: string;
    retriable?: boolean;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "TestRelicMcpError";
    this.code = opts.code;
    this.service = opts.service;
    this.retriable = opts.retriable ?? false;
    this.cause = opts.cause;
  }

  public toToolError(): { content: Array<{ type: "text"; text: string }>; isError: true; structuredContent: Record<string, unknown> } {
    return {
      isError: true,
      content: [{ type: "text", text: this.message }],
      structuredContent: {
        error: {
          code: this.code,
          message: this.message,
          service: this.service,
          retriable: this.retriable,
        },
      },
    };
  }
}

export class AuthError extends TestRelicMcpError {
  constructor(message: string, service?: string) {
    super({ code: "AUTH_ERROR", message, service, retriable: false });
  }
}

export class UpstreamError extends TestRelicMcpError {
  constructor(message: string, service?: string, retriable = true) {
    super({ code: "UPSTREAM_ERROR", message, service, retriable });
  }
}

export class NotFoundError extends TestRelicMcpError {
  constructor(message: string, service?: string) {
    super({ code: "NOT_FOUND", message, service, retriable: false });
  }
}

export class RateLimitedError extends TestRelicMcpError {
  constructor(message: string, service?: string) {
    super({ code: "RATE_LIMITED", message, service, retriable: true });
  }
}

export class InvalidInputError extends TestRelicMcpError {
  public readonly subcode?: string;
  constructor(message: string, subcode?: string) {
    super({ code: "INVALID_INPUT", message, retriable: false });
    this.subcode = subcode;
  }
}

export class CacheMissError extends TestRelicMcpError {
  constructor(message: string) {
    super({ code: "CACHE_MISS", message, retriable: false });
  }
}

export class CapabilityDisabledError extends TestRelicMcpError {
  constructor(capability: string) {
    super({
      code: "CAPABILITY_DISABLED",
      message: `Capability "${capability}" is disabled. Enable it with --caps=${capability} or add to the "capabilities" array in your config.`,
      retriable: false,
    });
  }
}

export class TimeoutError extends TestRelicMcpError {
  constructor(message: string, service?: string) {
    super({ code: "TIMEOUT", message, service, retriable: true });
  }
}

export class CircuitOpenError extends TestRelicMcpError {
  constructor(service: string) {
    super({
      code: "CIRCUIT_OPEN",
      message: `Circuit breaker is open for ${service}. Retries suppressed until the service recovers.`,
      service,
      retriable: true,
    });
  }
}

interface AxiosLikeError {
  isAxiosError: true;
  response?: { status: number; data?: unknown };
  code?: string;
  config?: { url?: string };
  message?: string;
}

function isAxiosError(err: unknown): err is AxiosLikeError {
  return typeof err === "object" && err !== null && (err as { isAxiosError?: boolean }).isAxiosError === true;
}

/**
 * Maps an axios/Error into a TestRelicMcpError. Preserves messages written for AI agents.
 */
/**
 * The platform's own explanation from a JSON error body
 * (`{ error: { code, message } }`, or a bare `{ message }`). It says what
 * actually went wrong ("Run X not found.", "ANTHROPIC_API_KEY is not
 * configured") where the status line alone does not.
 */
function platformError(err: AxiosLikeError): { code?: string; message?: string } {
  const data = err.response?.data as { error?: unknown; code?: unknown; message?: unknown } | undefined;
  if (!data || typeof data !== "object") return {};
  const e: { code?: unknown; message?: unknown } =
    data.error && typeof data.error === "object" ? (data.error as { code?: unknown; message?: unknown }) : data;
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? e.message : typeof data.error === "string" ? data.error : undefined,
  };
}

export function wrapUpstreamError(err: unknown, service: string): TestRelicMcpError {
  if (err instanceof TestRelicMcpError) return err;
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const platform = platformError(err);
    const detail = platform.message ? `: ${platform.message}` : "";
    if (status === 401 || status === 403) {
      return new AuthError(
        `${service} returned ${status} Unauthorized${detail}. Check credentials in your config or .env. If using mock mode, ensure MOCK_SERVER_URL is set and the mock server is running (npm run mock).`,
        service,
      );
    }
    if (status === 404) {
      return new NotFoundError(
        `${service} returned 404 Not Found${detail || ". The requested resource does not exist."}`,
        service,
      );
    }
    if (status === 429) {
      return new RateLimitedError(`${service} returned 429 Too Many Requests. Wait before retrying.`, service);
    }
    if (status === 501) {
      // A deliberate "not implemented": retrying cannot change the answer.
      return new UpstreamError(
        `${service} returned 501 Not Implemented${detail || ". This feature is not available on the platform yet."}`,
        service,
        false,
      );
    }
    if (status && status >= 500) {
      // A 5xx carrying the platform's own error code was a deliberate answer
      // (e.g. 503 AI_NOT_CONFIGURED) — the service is up, so a retry gets the
      // same reply. A bare 5xx is a gateway/outage and is worth retrying.
      return new UpstreamError(
        `${service} returned ${status} Server Error${detail || ". The service may be temporarily unavailable."}`,
        service,
        !platform.code,
      );
    }
    if (err.code === "ECONNREFUSED") {
      return new UpstreamError(
        `Cannot connect to ${service} at ${err.config?.url}. If using mock mode, start the mock server first: npm run mock`,
        service,
        true,
      );
    }
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return new TimeoutError(`${service} request timed out.`, service);
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return new UpstreamError(`${service} error: ${message}`, service, true);
}
