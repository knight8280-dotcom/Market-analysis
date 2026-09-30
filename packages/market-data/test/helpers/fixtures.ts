import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function fixture(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url)), "utf8");
}

/** A fetch stand-in that serves fixture files by URL pathname and records every request. */
export function fixtureFetch(routes: Record<string, string | { status: number; body?: string }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url.pathname];
    if (route === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (typeof route === "string")
      return Promise.resolve(new Response(fixture(route), { status: 200 }));
    return Promise.resolve(new Response(route.body ?? "{}", { status: route.status }));
  };
  return { fetch: impl, calls };
}
