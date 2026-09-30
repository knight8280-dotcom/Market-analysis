/**
 * The app answers only to loopback host names plus any configured in WEB_ALLOWED_HOSTS. A
 * DNS-rebinding page (evil.example resolving to 127.0.0.1) then gets nothing, not even the login
 * form.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function hostnameOf(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 ? host.slice(0, end + 1) : null;
  }
  const colon = host.indexOf(":");
  return colon >= 0 ? host.slice(0, colon) : host;
}

export function isAllowedHost(hostHeader: string | null, extra: readonly string[]): boolean {
  const name = hostnameOf(hostHeader);
  return name !== null && name !== "" && (LOOPBACK.has(name) || extra.includes(name));
}
