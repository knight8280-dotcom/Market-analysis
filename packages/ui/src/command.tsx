"use client";

import { Command } from "cmdk";
import { Dialog, VisuallyHidden } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

/**
 * Command palette shell (⌘K): a modal Radix dialog (focus trap, Escape, restores focus) around a
 * cmdk list with arrow-key navigation. Filtering is left to the caller (`shouldFilter`), so
 * results can come from the server.
 */
export function CommandDialog({
  open,
  onOpenChange,
  title,
  children,
  shouldFilter = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  shouldFilter?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[15vh] left-1/2 z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border bg-surface shadow-2xl"
        >
          <VisuallyHidden.Root>
            <Dialog.Title>{title}</Dialog.Title>
          </VisuallyHidden.Root>
          <Command label={title} shouldFilter={shouldFilter} loop>
            {children}
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof Command.Input>) {
  return (
    <Command.Input
      className={cn(
        "w-full border-b bg-transparent px-4 py-3 text-base outline-none placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof Command.List>) {
  return (
    <Command.List
      className={cn("max-h-[50vh] overflow-y-auto p-2 text-sm", className)}
      {...props}
    />
  );
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof Command.Group>) {
  return (
    <Command.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof Command.Item>) {
  return (
    <Command.Item
      className={cn(
        "flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-2 data-[selected=true]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

export function CommandEmpty(props: ComponentProps<typeof Command.Empty>) {
  return <Command.Empty className="px-2 py-6 text-center text-muted-foreground" {...props} />;
}

export const CommandLoading = Command.Loading;
