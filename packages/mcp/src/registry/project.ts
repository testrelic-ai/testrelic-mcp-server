import { InvalidInputError } from "../errors.js";
import type { ToolContext } from "./index.js";

/**
 * Resolve the project (cloud-platform-app repoId) a tool should operate on.
 *
 * Precedence:
 *   1. Explicit `project_id` argument from the caller — matched against
 *      bootstrap.repos[].id then .gitId (so users can pass either).
 *   2. `config.cloud.defaultRepoId` if set.
 *   3. If there's exactly one repo in bootstrap, use it silently.
 *   4. Throw InvalidInputError and include the available repo list in the
 *      structured error so the LLM can re-prompt the user.
 */
export function resolveProjectId(ctx: ToolContext, argProjectId?: string): string {
  const repos = ctx.bootstrap?.repos ?? [];
  if (argProjectId) {
    const match = repos.find((r) => r.id === argProjectId || r.gitId === argProjectId);
    if (match) return match.id;
    if (repos.length === 0) return argProjectId; // no bootstrap — trust caller
    throw new InvalidInputError(
      `Unknown project_id "${argProjectId}". Available repos: ${repos.map((r) => r.gitId).join(", ")}`,
      "UNKNOWN_PROJECT",
    );
  }
  if (ctx.config.cloud.defaultRepoId) return ctx.config.cloud.defaultRepoId;
  if (repos.length === 1) return repos[0]!.id;
  if (repos.length === 0) {
    throw new InvalidInputError(
      "No project_id provided and no repos found in bootstrap. Provide project_id or configure default_repo_id.",
      "PROJECT_REQUIRED",
    );
  }
  throw new InvalidInputError(
    `project_id is required when multiple repos exist. Available: ${repos.map((r) => r.gitId).join(", ")}`,
    "PROJECT_REQUIRED",
  );
}

/**
 * Require that a given integration type is connected in the current org.
 * Emits a clean, user-facing error pointing at the settings URL so the LLM
 * can tell the user exactly where to go.
 */
export function requireIntegration(ctx: ToolContext, type: string): void {
  const integration = ctx.bootstrap?.integrations.find((i) => i.type === type);
  if (integration?.connected) return;
  const base = ctx.config.cloud.baseUrl.replace(/\/api\/v1\/?$/, "");
  throw new InvalidInputError(
    `Integration "${type}" is not connected. Configure it at ${base}/settings/integrations`,
    "INTEGRATION_NOT_CONNECTED",
  );
}
