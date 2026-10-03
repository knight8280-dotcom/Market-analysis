/**
 * The Content-Security-Policy for one response (spec §8, ADR-039). Scripts run only with this
 * request's nonce (Next puts it on its own scripts) or when such a script loads them; nothing
 * else on the page may run script. Styles allow inline: React writes `style` attributes (heatmap
 * tiles, chart sizes), which a nonce cannot cover, and styles cannot run code. Everything else
 * comes from this origin only, and no other site may frame the app.
 */
export function contentSecurityPolicy(
  nonce: string,
  opts: { dev: boolean; https: boolean },
): string {
  return [
    "default-src 'self'",
    // React's development build evaluates code for its error overlays; production never does.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    // The indicator worker and the service worker are this origin's own scripts.
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Over HTTPS (the Tailscale address) never load anything over plain HTTP; on
    // http://localhost this would break every request.
    ...(opts.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** A fresh, unguessable nonce for each response. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
}

/** Whether the browser reached the app over HTTPS: directly, or through Tailscale Serve. */
export function viaHttps(headers: Headers, protocol: string): boolean {
  const forwarded = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return forwarded ? forwarded === "https" : protocol === "https:";
}
