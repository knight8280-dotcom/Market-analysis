import { z } from "zod";

/**
 * A small client for Anthropic's Messages API (Phase 2 step I2): one POST per request, the key
 * in the x-api-key header (never a URL), the host fixed to api.anthropic.com unless a test
 * overrides it, retries with backoff on rate limits and overload, and a time limit. Our own
 * client rather than the SDK: one endpoint, and the same pattern as every other vendor here.
 */
export const ANTHROPIC_HOST = "api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

export interface MessageRequest {
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  temperature?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface MessageResult {
  text: string;
  model: string;
  stopReason: string | null;
  usage: Usage;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiError";
  }
}

const Response_ = z.object({
  model: z.string(),
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullable().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().nullable().optional(),
  }),
});
const ErrorBody = z.object({ error: z.object({ type: z.string(), message: z.string() }) });

export interface AnthropicOptions {
  apiKey: string;
  /** Tests only: another origin to send requests to. */
  baseUrl?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  timeoutMs?: number;
}

export class AnthropicClient {
  private readonly base: string;
  private readonly fetch: NonNullable<AnthropicOptions["fetch"]>;
  private readonly sleep: NonNullable<AnthropicOptions["sleep"]>;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AnthropicOptions) {
    if (!opts.apiKey) throw new AiError("No Anthropic API key", null, false);
    this.base = opts.baseUrl ? new URL(opts.baseUrl).origin : `https://${ANTHROPIC_HOST}`;
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts.random ?? Math.random;
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  /** Text without the key, should an error ever echo it. */
  private redact(text: string): string {
    return text.split(this.opts.apiKey).join("[redacted]");
  }

  async createMessage(req: MessageRequest): Promise<MessageResult> {
    const body = JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    });
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetch(`${this.base}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": this.opts.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
            accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt, null));
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new AiError(this.redact(`Anthropic request failed: ${message}`), null, true);
      }
      const text = await response.text();
      if (response.ok) {
        let data: z.infer<typeof Response_>;
        try {
          data = Response_.parse(JSON.parse(text));
        } catch {
          throw new AiError("Unexpected response shape from Anthropic", response.status, false);
        }
        return {
          text: data.content
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join(""),
          model: data.model,
          stopReason: data.stop_reason ?? null,
          usage: {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            cacheWriteTokens: data.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
          },
        };
      }
      const retryable = RETRY_STATUSES.has(response.status);
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(this.backoff(attempt, response.headers.get("retry-after")));
        continue;
      }
      let detail = `HTTP ${response.status}`;
      try {
        const e = ErrorBody.parse(JSON.parse(text));
        detail = `HTTP ${response.status} ${e.error.type}: ${e.error.message}`;
      } catch {
        // Not Anthropic's error shape: the status says enough.
      }
      throw new AiError(
        this.redact(`Anthropic refused the request (${detail})`),
        response.status,
        retryable,
      );
    }
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    return Math.floor((0.5 + this.random() / 2) * Math.min(30_000, 1000 * 2 ** attempt));
  }
}
