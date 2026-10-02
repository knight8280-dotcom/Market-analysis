/**
 * The push services browsers use (spec §8: allowlist the hosts we fetch from). A subscription
 * is stored, and a message sent, only when its endpoint is HTTPS on one of these hosts, on the
 * default port, with no user name or password in it.
 */
const HOSTS: ReadonlySet<string> = new Set([
  // Chrome, Edge on Android, Samsung Internet, Opera (Firebase Cloud Messaging).
  "fcm.googleapis.com",
  // Firefox.
  "updates.push.services.mozilla.com",
  // Safari on macOS, iPhone and iPad.
  "web.push.apple.com",
]);
/** Edge on Windows: Windows Push Notification Services, one host per region. */
const HOST_SUFFIXES = [".notify.windows.com"];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return HOSTS.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

/** An endpoint's capability token never goes into logs: the host says enough. */
export function endpointLabel(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid endpoint";
  }
}

/** A stand-in push service on this machine (http://127.0.0.1 or localhost): tests only. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Which endpoints may be stored and sent to: the push services, plus loopback when
 * WEB_PUSH_ALLOW_LOOPBACK is set (the env schema allows that only when APP_ENV=test).
 */
export function endpointPolicy(allowLoopback: boolean): (endpoint: string) => boolean {
  return allowLoopback
    ? (endpoint) => isPushServiceEndpoint(endpoint) || isLoopbackEndpoint(endpoint)
    : isPushServiceEndpoint;
}
