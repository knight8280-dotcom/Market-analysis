import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ROUTES, PAGE_ROUTES, PUBLIC_ROUTES } from "../e2e/routes";

const APP = fileURLToPath(new URL("../src/app", import.meta.url));

/** App Router routes from the file tree: route groups like (app) do not appear in URLs. */
function routes(dir: string, file: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routes(path, file));
    else if (entry.name === file) {
      const segments = relative(APP, dir)
        .split(sep)
        .filter((s) => s && !/^\(.*\)$/.test(s));
      out.push(`/${segments.join("/")}`);
    }
  }
  return out;
}

describe("route inventory for the session check", () => {
  it("lists every page", () => {
    const pages = routes(APP, "page.tsx").filter((r) => !PUBLIC_ROUTES.includes(r));
    expect(pages.sort()).toEqual(Object.keys(PAGE_ROUTES).sort());
  });

  it("lists every API route", () => {
    const apis = routes(APP, "route.ts").filter((r) => !PUBLIC_ROUTES.includes(r));
    expect(apis.sort()).toEqual(Object.keys(API_ROUTES).sort());
  });
});
