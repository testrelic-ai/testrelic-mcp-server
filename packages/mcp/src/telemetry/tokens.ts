import { encode } from "gpt-tokenizer";

/**
 * Token counting using gpt-tokenizer (cl100k_base — OpenAI default encoder).
 *
 * This is an approximation for Anthropic / other models, but it's the
 * canonical open-source tokenizer and the usual Playwright MCP choice.
 * Accuracy within +/- 10% vs true Anthropic tokenization is acceptable
 * for budget enforcement purposes.
 */

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Fallback: rough 4 chars/token heuristic.
    return Math.ceil(text.length / 4);
  }
}

export function countObjectTokens(obj: unknown): number {
  if (obj == null) return 0;
  return countTokens(typeof obj === "string" ? obj : JSON.stringify(obj));
}

/**
 * Truncates text to stay under `maxTokens`, preserving a prefix/suffix with
 * a visible ellipsis marker.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const tokens = countTokens(text);
  if (tokens <= maxTokens) return text;
  const ratio = maxTokens / tokens;
  const approxChars = Math.max(64, Math.floor(text.length * ratio * 0.95));
  const head = text.slice(0, Math.floor(approxChars * 0.7));
  const tail = text.slice(-Math.floor(approxChars * 0.3));
  return `${head}\n\n... [truncated ${tokens - maxTokens} tokens — use tr_fetch_cached(cache_key) for full payload] ...\n\n${tail}`;
}
