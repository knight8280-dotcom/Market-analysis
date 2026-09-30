import { loadWebEnv } from "@market/config";
import type { NextRequest } from "next/server";
import { createCoalescer } from "../../../lib/coalesce";
import { ownerOr401 } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { subscribeMarketEvents } from "../../../server/live";
import { assertDisplayable, latestQuotes, priceSource } from "../../../server/market";

export const dynamic = "force-dynamic";

/**
 * Server-sent events for live views (Phase 1 step G2): `quote` events for the requested
 * securities when the worker reports new bars, at most one per second per security.
 * GET /api/stream?ids=1,2,3
 */
export async function GET(request: NextRequest): Promise<Response> {
  const denied = await ownerOr401();
  if (denied) return denied;
  const ids = new Set(
    (request.nextUrl.searchParams.get("ids") ?? "")
      .split(",")
      .filter((x) => /^\d{1,18}$/.test(x))
      .slice(0, 200),
  );
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const coalescer = createCoalescer<string>(1000, (securityId) => {
        void (async () => {
          const source = await priceSource(db());
          if (!source) return;
          assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
          const [quote] = await latestQuotes(db(), source, { securityIds: [securityId] });
          if (quote) write(`event: quote\ndata: ${JSON.stringify(quote)}\n\n`);
        })().catch(() => {});
      });
      const unsubscribe = subscribeMarketEvents((event) => {
        if (event.type === "bars_updated" && typeof event.securityId === "string") {
          if (ids.has(event.securityId)) coalescer.push(event.securityId, event.securityId);
        }
      });
      if (!unsubscribe) {
        write("event: unavailable\ndata: {}\n\n");
        controller.close();
        return;
      }
      const heartbeat = setInterval(() => write(": ping\n\n"), 25_000);
      cleanup = () => {
        clearInterval(heartbeat);
        coalescer.close();
        unsubscribe();
      };
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      write("retry: 5000\nevent: ready\ndata: {}\n\n");
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
