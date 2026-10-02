import { createECDH, createPrivateKey, type KeyObject, sign } from "node:crypto";

/**
 * VAPID (RFC 8292): the application server identifies itself to push services with a P-256 key
 * pair. The public key goes to the browser when it subscribes; every push request carries a
 * short-lived JWT signed with the private key. Keys are base64url, as browsers expect them: the
 * public key is the 65-byte uncompressed point, the private key the 32-byte scalar.
 */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** The key pair checked and ready to sign with; throws when the two do not belong together. */
export function vapidSigningKey(keys: VapidKeys): KeyObject {
  const pub = Buffer.from(keys.publicKey, "base64url");
  const priv = Buffer.from(keys.privateKey, "base64url");
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("The VAPID public key must be a 65-byte uncompressed P-256 point (base64url)");
  }
  if (priv.length !== 32) throw new Error("The VAPID private key must be 32 bytes (base64url)");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(priv);
  if (!ecdh.getPublicKey().equals(pub)) {
    throw new Error("The VAPID public key does not belong to the private key");
  }
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64u(priv),
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: "jwk",
  });
}

/** How long a signed token is good for: push services refuse more than 24 hours. */
export const VAPID_TOKEN_SECONDS = 12 * 3600;

/**
 * The `Authorization` header for one push request: a JWT for the push service's origin, signed
 * ES256, and our public key. `contact` is a mailto: or https: address the push service may use
 * to reach the sender (Apple requires one).
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  contact: string,
  now: Date,
  signingKey: KeyObject = vapidSigningKey(keys),
): string {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = json({ typ: "JWT", alg: "ES256" });
  const claims = json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1000) + VAPID_TOKEN_SECONDS,
    sub: contact,
  });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: signingKey,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}
