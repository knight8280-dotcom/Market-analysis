"use client";

import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Accessible tooltip: opens on hover and on keyboard focus, closes on Escape. The trigger must be
 * focusable; plain text is wrapped in a button-like span with tabIndex 0.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={200}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({
  content,
  children,
  side = "top",
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-50 max-w-xs rounded-md border bg-surface px-3 py-2 text-xs text-foreground shadow-lg",
            className,
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
