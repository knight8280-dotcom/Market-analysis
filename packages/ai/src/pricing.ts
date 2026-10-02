import type { Usage } from "./anthropic";

/**
 * US dollars per million tokens, from Anthropic's pricing page
 * (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-02). A model not
 * listed has no known price, so nothing is sent to it: the monthly cap could not be kept.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** Writing a prompt prefix to the five-minute cache. */
  cacheWrite: number;
  cacheRead: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
};

/** The price for a model id, including dated ids ("claude-haiku-4-5-20251001"). */
export function priceOf(model: string): ModelPrice | null {
  const key = Object.keys(MODEL_PRICES)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? MODEL_PRICES[key]! : null;
}

export function costUsd(model: string, usage: Usage): number | null {
  const p = priceOf(model);
  if (!p) return null;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheWriteTokens * p.cacheWrite +
      usage.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}

/**
 * The most a request can cost: its prompt at three characters a token (newer models' tokenizer
 * makes about 30% more tokens than the usual four characters) plus every output token allowed.
 */
export function maxCostUsd(model: string, promptChars: number, maxTokens: number): number | null {
  const p = priceOf(model);
  if (!p) return null;
  return (Math.ceil(promptChars / 3) * p.input + maxTokens * p.output) / 1_000_000;
}
