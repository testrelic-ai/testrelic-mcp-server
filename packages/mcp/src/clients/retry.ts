import { getLogger } from "../logger.js";
import { CircuitOpenError, RateLimitedError, TestRelicMcpError } from "../errors.js";

/**
 * Hand-rolled circuit breaker + exponential-backoff retry with full jitter.
 * No external deps. Designed to be safe for stdio transport: no process.exit
 * on open, just fails fast.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface CircuitOptions {
  /** Fail count before opening the circuit. */
  threshold?: number;
  /** How long to hold the circuit open after it trips. */
  cooldownMs?: number;
}

interface CircuitState {
  failures: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private readonly state: Record<string, CircuitState> = {};
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(opts: CircuitOptions = {}) {
    this.threshold = opts.threshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
  }

  public assertClosed(service: string): void {
    const s = this.state[service];
    if (!s || s.openedAt === null) return;
    if (Date.now() - s.openedAt > this.cooldownMs) {
      this.state[service] = { failures: 0, openedAt: null };
      return;
    }
    throw new CircuitOpenError(service);
  }

  public recordSuccess(service: string): void {
    this.state[service] = { failures: 0, openedAt: null };
  }

  public recordFailure(service: string): void {
    const s = this.state[service] ?? { failures: 0, openedAt: null };
    s.failures++;
    if (s.failures >= this.threshold && s.openedAt === null) {
      s.openedAt = Date.now();
      getLogger().warn({ service, failures: s.failures }, "circuit breaker tripped");
    }
    this.state[service] = s;
  }

  public isOpen(service: string): boolean {
    const s = this.state[service];
    if (!s || s.openedAt === null) return false;
    return Date.now() - s.openedAt < this.cooldownMs;
  }
}

export async function withRetry<T>(
  service: string,
  fn: () => Promise<T>,
  opts: RetryOptions = {},
  breaker?: CircuitBreaker,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;

  if (breaker) breaker.assertClosed(service);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      breaker?.recordSuccess(service);
      return result;
    } catch (err) {
      lastErr = err;
      const retriable = err instanceof TestRelicMcpError ? err.retriable : true;
      if (!retriable || attempt === maxRetries) {
        breaker?.recordFailure(service);
        throw err;
      }
      if (err instanceof RateLimitedError) {
        // Rate-limited: longer backoff, don't count toward circuit breaker.
        const wait = Math.min(maxDelayMs, baseDelayMs * Math.pow(4, attempt));
        await sleep(jittered(wait));
        continue;
      }
      const wait = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      await sleep(jittered(wait));
    }
  }
  breaker?.recordFailure(service);
  throw lastErr;
}

function jittered(ms: number): number {
  return Math.floor(Math.random() * ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
