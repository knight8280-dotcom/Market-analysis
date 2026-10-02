"use client";

import type { FlagKey } from "@market/config";
import { cn } from "@market/ui";
import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isActive, splitNav, visibleNav } from "../lib/nav";

/** Left navigation, from medium screens up. */
export function Nav({ flags }: { flags: Partial<Record<FlagKey, boolean>> }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {visibleNav(flags).map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
              active && "bg-muted font-medium text-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Bottom navigation on phones (spec §6): four sections within reach of a thumb and "More" for
 * the rest, above the home bar. Hidden from medium screens up, where the left navigation shows
 * everything.
 */
export function BottomNav({ flags }: { flags: Partial<Record<FlagKey, boolean>> }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { bar, more } = splitNav(visibleNav(flags));
  const inMore = more.some((item) => isActive(pathname, item.href));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const tab = (active: boolean) =>
    cn(
      "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs",
      active ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
    );
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:hidden"
    >
      <ul className="grid grid-cols-5 gap-1">
        {bar.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={tab(active)}
              >
                <Icon aria-hidden className="size-5" />
                {label}
              </Link>
            </li>
          );
        })}
        <li>
          <button
            ref={button}
            type="button"
            aria-expanded={open}
            aria-controls="more-nav"
            onClick={() => setOpen((o) => !o)}
            className={tab(open || inMore)}
          >
            <Menu aria-hidden className="size-5" />
            More
          </button>
        </li>
      </ul>
      {/* After the button in reading order, so Tab moves into it; shown above the bar. */}
      <div
        ref={panel}
        id="more-nav"
        hidden={!open}
        className="absolute inset-x-0 bottom-full border-t bg-surface p-2 shadow-lg"
      >
        <ul className="grid grid-cols-2 gap-1">
          {more.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                    active && "bg-muted font-medium text-foreground",
                  )}
                >
                  <Icon aria-hidden className="size-4" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
