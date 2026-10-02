import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

/**
 * Message encryption for Web Push (RFC 8291, "aes128gcm" content coding from RFC 8188): only
 * the browser that subscribed can read a message; the push service in between sees ciphertext.
 * A fresh key pair and salt per message; one record, padded with nothing.
 */
export interface SubscriptionKeys {
  /** The browser's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string;
  /** The browser's 16-byte authentication secret, base64url. */
  auth: string;
}

const RECORD_SIZE = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65;
const TAG_BYTES = 16;
/** The most plaintext one record holds (push services need not take more than 4096 bytes). */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1;

function keyInfo(uaPublic: Buffer, asPublic: Buffer): Buffer {
  return Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
}

function contentKeys(ecdhSecret: Buffer, auth: Buffer, info: Buffer, salt: Buffer) {
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, auth, info, 32));
  return {
    cek: Buffer.from(
      hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16),
    ),
    nonce: Buffer.from(
      hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12),
    ),
  };
}

function subscriptionKeys(keys: SubscriptionKeys): { uaPublic: Buffer; auth: Buffer } {
  const uaPublic = Buffer.from(keys.p256dh, "base64url");
  const auth = Buffer.from(keys.auth, "base64url");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error("The subscription's p256dh key is not an uncompressed P-256 point");
  }
  if (auth.length !== 16) throw new Error("The subscription's auth secret is not 16 bytes");
  return { uaPublic, auth };
}

/**
 * The request body for one push message. `sender` and `salt` exist for the RFC's test vector;
 * otherwise both are new for every message.
 */
export function encryptPayload(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
  fixed: { senderPrivateKey?: Uint8Array; salt?: Uint8Array } = {},
): Buffer {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`A push message holds at most ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  const { uaPublic, auth } = subscriptionKeys(keys);
  const sender = createECDH("prime256v1");
  if (fixed.senderPrivateKey) sender.setPrivateKey(Buffer.from(fixed.senderPrivateKey));
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const salt = fixed.salt ? Buffer.from(fixed.salt) : randomBytes(16);
  const { cek, nonce } = contentKeys(
    sender.computeSecret(uaPublic),
    auth,
    keyInfo(uaPublic, asPublic),
    salt,
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(65, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([header, body]);
}

/**
 * What the browser does with a message: used by the tests' stand-in push service, which holds
 * the subscription's private key. Throws on anything that does not decrypt exactly.
 */
export function decryptPayload(
  body: Uint8Array,
  keys: SubscriptionKeys & { privateKey: string },
): Buffer {
  const data = Buffer.from(body);
  const { uaPublic, auth } = subscriptionKeys(keys);
  const idLength = data.readUInt8(20);
  const salt = data.subarray(0, 16);
  const recordSize = data.readUInt32BE(16);
  const asPublic = data.subarray(21, 21 + idLength);
  const record = data.subarray(21 + idLength);
  if (record.length > recordSize) throw new Error("More than one record");
  const receiver = createECDH("prime256v1");
  receiver.setPrivateKey(Buffer.from(keys.privateKey, "base64url"));
  const { cek, nonce } = contentKeys(
    receiver.computeSecret(asPublic),
    auth,
    keyInfo(uaPublic, asPublic),
    salt,
  );
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - TAG_BYTES));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - TAG_BYTES)),
    decipher.final(),
  ]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 0x02) throw new Error("No final-record delimiter");
  return padded.subarray(0, end);
}
