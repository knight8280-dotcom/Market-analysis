"use client";

import type { FlagKey } from "@market/config";
import { Badge, Button, Kbd } from "@market/ui";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@market/ui/client";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { visibleNav } from "./nav";

interface Result {
  ticker: string;
  name: string;
  assetClass: string;
  active: boolean;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Global command palette (spec §6): ⌘K / Ctrl+K or "/" opens it; type a ticker or company name,
 * arrow keys to move, Enter to open. Results come from /api/search.
 */
export function CommandMenu({ flags }: { flags: Partial<Record<FlagKey, boolean>> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "/" && !isTyping(e.target)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Search failed (${res.status})`);
          const body = (await res.json()) as { results: Result[] };
          setResults(body.results);
          setError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError("Search is unavailable. Check that the app can reach the database.");
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className="w-full justify-start text-muted-foreground sm:w-72"
        aria-keyshortcuts="Meta+K Control+K /"
      >
        <Search aria-hidden />
        <span className="flex-1 text-left">Search tickers…</span>
        <Kbd>⌘K</Kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search" shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Ticker or company name"
          aria-label="Ticker or company name"
        />
        <CommandList>
          {error ? <p className="px-2 py-6 text-center text-down">{error}</p> : null}
          {query.trim() && !error ? <CommandEmpty>No matching securities.</CommandEmpty> : null}
          {results.length > 0 ? (
            <CommandGroup heading="Securities">
              {results.map((r) => (
                <CommandItem
                  key={r.ticker}
                  value={`security:${r.ticker}`}
                  onSelect={() => go(`/stocks/${encodeURIComponent(r.ticker)}`)}
                >
                  <span className="w-24 shrink-0 font-mono font-medium">{r.ticker}</span>
                  <span className="flex-1 truncate text-muted-foreground">{r.name}</span>
                  {r.assetClass !== "equity" ? <Badge>{r.assetClass.toUpperCase()}</Badge> : null}
                  {!r.active ? <Badge tone="warning">Delisted</Badge> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {!query.trim() ? (
            <CommandGroup heading="Go to">
              {visibleNav(flags).map(({ href, label, icon: Icon }) => (
                <CommandItem key={href} value={`page:${href}`} onSelect={() => go(href)}>
                  <Icon aria-hidden className="size-4 text-muted-foreground" />
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>
    </>
  );
}
