import type { ToolContext, ToolDefinition, ToolRegistry } from "../registry/index.js";
import { coreTools } from "./core/index.js";
import { coverageTools } from "./coverage/index.js";
import { creationTools } from "./creation/index.js";
import { healingTools } from "./healing/index.js";
import { impactTools } from "./impact/index.js";
import { triageTools } from "./triage/index.js";
import { signalsTools } from "./signals/index.js";
import { devtoolsTools } from "./devtools/index.js";

/**
 * Centralised tool bundle. The registry filters by capability; unknown
 * capabilities are silently dropped. Adding a new capability = append one
 * entry here.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  ...coreTools,
  ...coverageTools,
  ...creationTools,
  ...healingTools,
  ...impactTools,
  ...triageTools,
  ...signalsTools,
  ...devtoolsTools,
];

export function registerAllTools(ctx: ToolContext, registry: ToolRegistry): void {
  for (const tool of ALL_TOOLS) {
    registry.register(ctx, tool);
  }
}
