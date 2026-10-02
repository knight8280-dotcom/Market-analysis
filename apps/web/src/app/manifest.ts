import type { MetadataRoute } from "next";
import { BRAND } from "../brand";
import { APP_BACKGROUND, iconPath, SHORT_NAME } from "../lib/pwa";

/**
 * Web app manifest (spec §6, ADR-037): lets a browser install the app on the computer or the
 * phone. It names the app and its icons only; it is served without a session because browsers
 * fetch it without cookies.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: BRAND,
    short_name: SHORT_NAME,
    description: "Personal market analytics: charts, fundamentals, screens, alerts.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: APP_BACKGROUND,
    theme_color: APP_BACKGROUND,
    categories: ["finance"],
    icons: [
      { src: iconPath(192), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: iconPath(512), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: iconPath(512), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
