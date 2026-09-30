"use client";

import { TooltipProvider } from "@market/ui/client";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}
