/**
 * Auth validation helpers.
 * Error messages are written for AI agents — they describe what to do next,
 * not just what failed.
 */

export function assertTestrelicKey(): void {
  const usingReal = !!process.env.TESTRELIC_API_BASE_URL;
  if (usingReal && !process.env.TESTRELIC_API_KEY) {
    throw new Error(
      "TESTRELIC_API_KEY is missing or invalid. " +
        "Set it via: export TESTRELIC_API_KEY=your_key " +
        "(get yours from app.testrelic.ai/settings/api-keys)"
    );
  }
}

export function assertAmplitudeKeys(): void {
  const apiKey = process.env.AMPLITUDE_API_KEY;
  const secretKey = process.env.AMPLITUDE_SECRET_KEY;

  if (apiKey && !secretKey) {
    throw new Error(
      "AMPLITUDE_SECRET_KEY is missing. Amplitude data queries require both " +
        "AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY (HTTP Basic Auth). " +
        "Get your secret key from: analytics.amplitude.com → Settings → Projects → [project] → API Keys."
    );
  }

  if (!apiKey && secretKey) {
    throw new Error(
      "AMPLITUDE_API_KEY is missing. Amplitude data queries require both " +
        "AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY. " +
        "Get your API key from: analytics.amplitude.com → Settings → Projects → [project] → API Keys."
    );
  }
}

export function assertLokiCredentials(): void {
  const usingReal = !!process.env.LOKI_BASE_URL;
  if (usingReal) {
    if (!process.env.LOKI_USERNAME || !process.env.LOKI_PASSWORD) {
      throw new Error(
        "LOKI_USERNAME and LOKI_PASSWORD are required when LOKI_BASE_URL is set. " +
          "Set both in your .env file. If using Grafana Cloud, use your Grafana username " +
          "and a service account token as the password."
      );
    }
  }
}

export function assertJiraCredentials(): void {
  const usingReal = !!process.env.JIRA_BASE_URL;
  if (usingReal) {
    if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
      throw new Error(
        "JIRA_EMAIL and JIRA_API_TOKEN are required when JIRA_BASE_URL is set. " +
          "Create an API token at: id.atlassian.com/manage-profile/security/api-tokens"
      );
    }
  }
}

/**
 * Wraps an axios error into an agent-readable message.
 * Catches common HTTP status codes and explains what they mean for the agent.
 */
export function formatClientError(err: unknown, service: string): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return (
        `${service} returned ${status} Unauthorized. ` +
        `Check your API credentials in .env. ` +
        `If using mock mode, ensure MOCK_SERVER_URL=http://localhost:4000 and the mock server is running (npm run mock).`
      );
    }
    if (status === 404) {
      return `${service} returned 404 Not Found. The requested resource does not exist.`;
    }
    if (status === 429) {
      return `${service} returned 429 Too Many Requests. Wait before retrying.`;
    }
    if (status && status >= 500) {
      return `${service} returned ${status} Server Error. The service may be temporarily unavailable. Retry after a short delay.`;
    }
    if (err.code === "ECONNREFUSED") {
      return (
        `Cannot connect to ${service} at ${err.config?.url}. ` +
        `If using mock mode, start the mock server first: npm run mock`
      );
    }
  }
  return `${service} error: ${String(err)}`;
}

function isAxiosError(
  err: unknown
): err is { response?: { status: number }; code?: string; config?: { url?: string } } {
  return typeof err === "object" && err !== null && "isAxiosError" in err;
}
