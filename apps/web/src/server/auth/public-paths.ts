import {
  APPLE_ICON_PATH,
  ICON_SIZES,
  iconPath,
  MANIFEST_PATH,
  SERVICE_WORKER_PATH,
} from "../../lib/pwa";

/**
 * Paths served without a session (ADR-015, ADR-037): the login form, robots.txt, and what a
 * browser needs to install the app. Browsers fetch the manifest and its icons without cookies,
 * so they cannot sit behind the login. None of these holds personal data: the app's name, its
 * icons and the service worker script. Exact paths only, never a prefix.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/login",
  "/robots.txt",
  MANIFEST_PATH,
  SERVICE_WORKER_PATH,
  APPLE_ICON_PATH,
  ...ICON_SIZES.map(iconPath),
]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}
