import { AnthropicClient } from "@market/ai";
import type { WorkerEnv } from "@market/config";
import type { AiServices } from "./context";

/** AI services when the owner's Anthropic key is set; none otherwise. */
export function aiFromEnv(env: WorkerEnv): AiServices | undefined {
  if (!env.ANTHROPIC_API_KEY) return undefined;
  return {
    client: new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY }),
    monthlyBudgetUsd: env.AI_MONTHLY_BUDGET_USD,
    sentimentModel: env.AI_SENTIMENT_MODEL,
  };
}
