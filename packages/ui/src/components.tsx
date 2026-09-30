import { cva, type VariantProps } from "class-variance-authority";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { formatPercent } from "./format";

/* Server-safe building blocks (no hooks, no browser APIs). Client widgets live in client.ts. */

export const buttonVariants = cva(
  "inline-flex min-h-9 min-w-9 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary-solid text-primary-solid-foreground hover:bg-primary-solid/90",
        secondary: "border bg-surface hover:bg-muted",
        ghost: "hover:bg-muted",
        destructive: "border border-down/60 text-down hover:bg-down/10",
      },
      size: {
        sm: "min-h-8 px-2.5 text-xs",
        md: "px-3.5",
        icon: "p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "min-h-9 w-full rounded-md border bg-background px-3 text-sm placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-lg border bg-surface", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-start justify-between gap-4 px-4 pt-4", className)}>
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
  {
    variants: {
      tone: {
        neutral: "text-muted-foreground",
        up: "border-up/40 text-up",
        down: "border-down/40 text-down",
        warning: "border-warning/50 text-warning",
        info: "border-primary/40 text-primary",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function Th({ className, numeric, ...props }: ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b px-3 py-2 text-left text-xs font-medium text-muted-foreground",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, numeric, ...props }: ComponentProps<"td"> & { numeric?: boolean }) {
  return (
    <td
      className={cn("border-b border-border/60 px-3 py-2", numeric && "text-right", className)}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div aria-hidden className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />
  );
}

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A signed change. Direction is shown by sign, arrow and color together, never color alone
 * (spec §6; WCAG 1.4.1).
 */
export function Delta({
  fraction,
  className,
  digits = 2,
}: {
  fraction: number | string | null | undefined;
  className?: string;
  digits?: number;
}) {
  const n = fraction === null || fraction === undefined ? null : Number(fraction);
  if (n === null || !Number.isFinite(n)) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }
  const dir = n > 0 ? "up" : n < 0 ? "down" : "flat";
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  const label = dir === "up" ? "up" : dir === "down" ? "down" : "unchanged";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 whitespace-nowrap",
        dir === "up" && "text-up",
        dir === "down" && "text-down",
        dir === "flat" && "text-muted-foreground",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{label} </span>
      {formatPercent(n, digits)}
    </span>
  );
}

/** Empty state with a primary action (spec §6 states). */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children ? <p className="max-w-md text-sm text-muted-foreground">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
