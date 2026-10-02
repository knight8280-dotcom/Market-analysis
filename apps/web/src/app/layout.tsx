import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { BRAND } from "../brand";
import { Providers } from "../components/providers";
import { ServiceWorker } from "../components/service-worker";
import { SHORT_NAME } from "../lib/pwa";
import { currentTheme } from "../server/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: BRAND, template: `%s · ${BRAND}` },
  applicationName: BRAND,
  // Installed on an iPhone or iPad (ADR-037): full screen, with this name on the Home Screen.
  appleWebApp: { capable: true, title: SHORT_NAME, statusBarStyle: "default" },
  // Personal use only (ADR-015): nothing here is for search engines.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
  // Lay out under a phone's rounded corners and home bar; the safe-area padding below and on
  // the bottom navigation keeps content clear of them.
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await currentTheme();
  return (
    <html lang="en" data-theme={theme}>
      <body className="min-h-dvh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] font-sans text-foreground">
        <Providers>{children}</Providers>
        <ServiceWorker />
      </body>
    </html>
  );
}
