import "server-only";
import { loadWebEnv } from "@market/config";
import { Redis } from "ioredis";

/**
 * One Redis subscription to the worker's market-events channel per server process, shared by
 * every open live view. Returns null when REDIS_URL is not set (live updates are optional).
 */
type Listener = (event: { type: string; [k: string]: unknown }) => void;

const g = globalThis as unknown as { liveHub?: { redis: Redis; listeners: Set<Listener> } };

function hub() {
  if (g.liveHub) return g.liveHub;
  const url = loadWebEnv().REDIS_URL;
  if (!url) return null;
  const redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: null });
  redis.on("error", () => {}); // reconnects on its own; views fall back to page data meanwhile
  const listeners = new Set<Listener>();
  void redis.subscribe("market-events").catch(() => {});
  redis.on("message", (_channel: string, message: string) => {
    let event: unknown;
    try {
      event = JSON.parse(message);
    } catch {
      return;
    }
    if (event && typeof event === "object" && "type" in event) {
      for (const l of listeners) l(event as Parameters<Listener>[0]);
    }
  });
  g.liveHub = { redis, listeners };
  return g.liveHub;
}

export function subscribeMarketEvents(listener: Listener): (() => void) | null {
  const h = hub();
  if (!h) return null;
  h.listeners.add(listener);
  return () => h.listeners.delete(listener);
}
