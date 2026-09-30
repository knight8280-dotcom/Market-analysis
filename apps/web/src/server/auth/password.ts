import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Owner password hashing with scrypt (OWASP parameters: N = 2^17, r = 8, p = 1). The encoded
 * form carries its parameters, so they can be raised later without invalidating old hashes:
 * `scrypt:<log2 N>:<r>:<p>:<salt>:<hash>`, base64url, matching PASSWORD_HASH_PATTERN.
 */
const DEFAULTS = { log2N: 17, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

function options(log2N: number, r: number, p: number): ScryptOptions {
  const N = 2 ** log2N;
  // scrypt needs 128 * N * r bytes; leave headroom over Node's 32 MiB default.
  return { N, r, p, maxmem: 256 * N * r };
}

export async function hashPassword(
  password: string,
  params: { log2N: number; r: number; p: number } = DEFAULTS,
): Promise<string> {
  if (password.length < 12) throw new RangeError("Use a password of at least 12 characters");
  const salt = randomBytes(16);
  const key = await derive(password, salt, options(params.log2N, params.r, params.p));
  return [
    "scrypt",
    params.log2N,
    params.r,
    params.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join(":");
}

/** Constant-time check. A malformed hash never matches (and never throws). */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [log2N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![log2N, r, p].every((n) => Number.isInteger(n) && n > 0) || log2N > 20) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt, options(log2N, r, p));
  return timingSafeEqual(actual, expected);
}
