import { createPublicKey, verify } from "node:crypto";

export interface VapidCheck {
  valid: boolean;
  /** The public key the header names. */
  publicKey: string;
  header: unknown;
  claims: { aud?: unknown; exp?: unknown; sub?: unknown };
}

/**
 * What a push service does with our `Authorization` header: checks the ES256 signature with the
 * public key it names. Used by the tests' stand-in push services; never needed to send.
 */
export function checkVapidAuthorization(authorization: string): VapidCheck {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization);
  if (!match) throw new Error("Not a VAPID Authorization header");
  const [, head = "", claims = "", signature = "", publicKey = ""] = match;
  const pub = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as unknown;
  return {
    valid: verify(
      "sha256",
      Buffer.from(`${head}.${claims}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
    publicKey,
    header: decode(head),
    claims: decode(claims) as VapidCheck["claims"],
  };
}
