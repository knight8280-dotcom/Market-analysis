import { describe, expect, it } from "vitest";
import { AiError, AnthropicClient, costUsd, maxCostUsd, priceOf } from "../src";

/** Anthropic Messages API client (Phase 2 step I2) against a stub host; no real key or call. */
interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stub(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const client = new AnthropicClient({
    apiKey: "sk-ant-test-key-123",
    baseUrl: "https://anthropic.test",
    fetch: (input, init) => {
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
          string,
          unknown
        >,
      });
      const next = responses.shift();
      return next ? Promise.resolve(next()) : Promise.reject(new Error("no more responses"));
    },
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
  });
  return { client, calls, waits };
}

const ok = (text: string) =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 },
    }),
  );

const request = {
  model: "claude-haiku-4-5-20251001",
  system: "Rate.",
  messages: [{ role: "user" as const, content: "[]" }],
  maxTokens: 500,
  temperature: 0,
};

describe("AnthropicClient", () => {
  it("posts one message with the key in a header, and reads text and usage", async () => {
    const { client, calls } = stub([() => ok("[]")]);
    expect(await client.createMessage(request)).toEqual({
      text: "[]",
      model: "claude-haiku-4-5-20251001",
      stopReason: "end_turn",
      usage: { inputTokens: 1200, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 0 },
    });
    expect(calls[0]).toMatchObject({
      url: "https://anthropic.test/v1/messages",
      headers: {
        "x-api-key": "sk-ant-test-key-123",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: "Rate.",
        messages: [{ role: "user", content: "[]" }],
        temperature: 0,
      },
    });
    expect(calls[0]!.url).not.toContain("sk-ant");
  });

  it("waits and tries again when rate limited or overloaded, then gives up", async () => {
    const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "3" } });
    const overloaded = () => new Response("{}", { status: 529 });
    const retried = stub([limited, overloaded, () => ok("[]")]);
    expect((await retried.client.createMessage(request)).text).toBe("[]");
    expect(retried.waits).toEqual([3000, 2000]);

    const failing = stub([overloaded, overloaded, overloaded]);
    await expect(failing.client.createMessage(request)).rejects.toMatchObject({
      status: 529,
      retryable: true,
    });
  });

  it("says why a request was refused, without the key", async () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "bad model for key sk-ant-test-key-123" },
    });
    const { client } = stub([() => new Response(body, { status: 400 })]);
    const err = await client.createMessage(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).message).toBe(
      "Anthropic refused the request (HTTP 400 invalid_request_error: bad model for key [redacted])",
    );
    expect((err as AiError).retryable).toBe(false);
  });

  it("refuses a reply in another shape", async () => {
    const { client } = stub([() => new Response(JSON.stringify({ content: "?" }))]);
    await expect(client.createMessage(request)).rejects.toThrow("Unexpected response shape");
  });
});

describe("pricing", () => {
  it("prices the models by Anthropic's table, dated ids included", () => {
    expect(priceOf("claude-haiku-4-5-20251001")).toMatchObject({ input: 1, output: 5 });
    expect(priceOf("claude-sonnet-5-5")).toMatchObject({ input: 2, output: 10 });
    expect(priceOf("claude-opus-5-5")).toMatchObject({ input: 4, output: 20 });
    expect(priceOf("some-other-model")).toBeNull();
    expect(
      costUsd("claude-haiku-4-5-20251001", {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBeCloseTo(2);
    // 3,000 characters at three a token, plus 500 output tokens.
    expect(maxCostUsd("claude-haiku-4-5-20251001", 3000, 500)).toBeCloseTo(0.0035);
    expect(maxCostUsd("unknown", 3000, 500)).toBeNull();
  });
});
