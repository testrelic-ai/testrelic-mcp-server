import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import PQueue from "p-queue";
import type { ResolvedConfig } from "../config.js";
import { wrapUpstreamError } from "../errors.js";
import { CircuitBreaker, withRetry } from "./retry.js";

/**
 * Shared axios wrapper. Every upstream request in v2 goes through a single
 * ServiceClient pointed at cloud-platform-app, so retry / circuit-breaker /
 * rate-limit behaviour is uniform.
 */

export interface ServiceClientOptions {
  service: string;
  baseUrl: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Concurrent in-flight request cap per service. */
  concurrency?: number;
  /** Requests per second ceiling. */
  intervalCap?: number;
  intervalMs?: number;
}

export class ServiceClient {
  private readonly axios: AxiosInstance;
  private readonly queue: PQueue;
  private readonly breaker: CircuitBreaker;
  private readonly service: string;

  constructor(opts: ServiceClientOptions) {
    this.service = opts.service;
    this.axios = axios.create({
      baseURL: opts.baseUrl,
      timeout: opts.timeoutMs,
      headers: opts.headers,
    });
    this.queue = new PQueue({
      concurrency: opts.concurrency ?? 8,
      interval: opts.intervalMs ?? 1_000,
      intervalCap: opts.intervalCap ?? 32,
    });
    this.breaker = new CircuitBreaker({ threshold: 5, cooldownMs: 30_000 });
  }

  public async request<T>(cfg: AxiosRequestConfig): Promise<T> {
    return this.queue.add(
      async () => {
        return withRetry(
          this.service,
          async () => {
            try {
              const { data } = await this.axios.request<T>(cfg);
              return data;
            } catch (err) {
              throw wrapUpstreamError(err, this.service);
            }
          },
          { maxRetries: 3, baseDelayMs: 250 },
          this.breaker,
        );
      },
      { throwOnTimeout: true },
    ) as Promise<T>;
  }

  public get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>({ url, method: "GET", params });
  }

  public post<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>({ url, method: "POST", data: body });
  }

  public patch<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>({ url, method: "PATCH", data: body });
  }

  public isCircuitOpen(): boolean {
    return this.breaker.isOpen(this.service);
  }
}

export interface ClientContext {
  config: ResolvedConfig;
}

/**
 * Build the single authenticated cloud client. Base URL is resolved at config
 * time (prod URL, custom URL, or mock-server URL in mockMode). The Bearer
 * token is the user's MCP PAT (`tr_mcp_*`).
 */
export function buildCloudClient(ctx: ClientContext): ServiceClient {
  const { baseUrl, token } = ctx.config.cloud;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new ServiceClient({
    service: "cloud",
    baseUrl,
    timeoutMs: ctx.config.timeouts.upstream,
    headers,
  });
}
