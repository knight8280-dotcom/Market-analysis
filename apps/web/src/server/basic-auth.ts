import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Checks an HTTP Basic Authorization header. Both parts are compared as SHA-256 digests with
 * timingSafeEqual, so neither the result nor the timing reveals where a guess went wrong or how
 * long the real values are.
 */
export function checkBasicAuth(
  header: string | null,
  expected: { user: string; password: string },
): boolean {
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const userOk = timingSafeEqual(digest(decoded.slice(0, sep)), digest(expected.user));
  const passOk = timingSafeEqual(digest(decoded.slice(sep + 1)), digest(expected.password));
  return userOk && passOk;
}
