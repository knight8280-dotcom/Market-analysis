/**
 * The installable app (spec §6, ADR-037): paths and colors shared by the manifest, the icons,
 * the service worker registration and the proxy, which serves these few paths without a session.
 */
export const MANIFEST_PATH = "/manifest.webmanifest";
export const SERVICE_WORKER_PATH = "/sw.js";

/** Square PNG icons drawn by `app/icon.tsx`: the browser tab and the manifest's two sizes. */
export const ICON_SIZES = [32, 192, 512] as const;
export const iconPath = (size: (typeof ICON_SIZES)[number]) => `/icon/${size}`;
/** iPhone and iPad Home Screen icon, drawn by `app/apple-icon.tsx`. */
export const APPLE_ICON_PATH = "/apple-icon";
export const APPLE_ICON_SIZE = 180;

/** What the Home Screen or launcher shows under the icon (about 12 characters fit). */
export const SHORT_NAME = "Markets";

/** The dark theme's background (packages/ui styles.css): splash screen and title bar. */
export const APP_BACKGROUND = "#0d1117";
