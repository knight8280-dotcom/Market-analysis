"use client";

import { Button } from "@market/ui";
import { Tooltip } from "@market/ui/client";
import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";

type Theme = "dark" | "light" | "system";
const NEXT: Record<Theme, Theme> = { dark: "light", light: "system", system: "dark" };
const LABEL: Record<Theme, string> = {
  dark: "Dark theme",
  light: "Light theme",
  system: "System theme",
};
const ICON = { dark: Moon, light: Sun, system: Monitor };

/** Cycles dark → light → system. Stored in a cookie so the server renders the right theme. */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const Icon = ICON[theme];
  const change = () => {
    const next = NEXT[theme];
    setTheme(next);
    document.documentElement.dataset.theme = next;
    document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax`;
  };
  return (
    <Tooltip content={`${LABEL[theme]} (click to change)`}>
      <Button
        variant="ghost"
        size="icon"
        onClick={change}
        aria-label={`${LABEL[theme]}; change theme`}
      >
        <Icon aria-hidden />
      </Button>
    </Tooltip>
  );
}
