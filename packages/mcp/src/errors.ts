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
export function wrapUpstreamError(err: unknown, service: string): TestRelicMcpError {
  if (err instanceof TestRelicMcpError) return err;
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return new AuthError(
        `${service} returned ${status} Unauthorized. Check credentials in your config or .env. If using mock mode, ensure MOCK_SERVER_URL is set and the mock server is running (npm run mock).`,
        service,
      );
    }
    if (status === 404) {
      return new NotFoundError(`${service} returned 404 Not Found. The requested resource does not exist.`, service);
    }
    if (status === 429) {
      return new RateLimitedError(`${service} returned 429 Too Many Requests. Wait before retrying.`, service);
    }
    if (status && status >= 500) {
      return new UpstreamError(
        `${service} returned ${status} Server Error. The service may be temporarily unavailable.`,
        service,
        true,
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
