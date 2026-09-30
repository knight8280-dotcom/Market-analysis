import { cookies } from "next/headers";

export const THEMES = ["dark", "light", "system"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = "theme";

/** Dark by default (spec §6); "system" follows prefers-color-scheme. */
export async function currentTheme(): Promise<Theme> {
  const value = (await cookies()).get(THEME_COOKIE)?.value;
  return (THEMES as readonly string[]).includes(value ?? "") ? (value as Theme) : "dark";
}
