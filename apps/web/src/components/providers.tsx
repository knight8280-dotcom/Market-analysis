"use client";

import { TooltipProvider } from "@market/ui/client";
import type { ReactNode } from "react";
import { z } from "zod";

// Zod probes whether it may compile validators with `new Function`; the CSP forbids that
// (ADR-039), so the probe would be reported as a violation. Validation is the same without it.
z.config({ jitless: true });

export function Providers({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}
