import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPayload, encryptPayload, MAX_PLAINTEXT_BYTES } from "../src/encrypt";

const b64u = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "base64url");

/** RFC 8291, section 5 and Appendix A: the published example, byte for byte (no secrets). */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg", // gitleaks:allow (RFC 8291's published example)
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};
const rfcKeys = { p256dh: RFC.uaPublic, auth: RFC.auth };

function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

describe("Web Push encryption (RFC 8291)", () => {
  it("reproduces the RFC's example exactly", () => {
    const body = encryptPayload(Buffer.from(RFC.plaintext), rfcKeys, {
      senderPrivateKey: b64u(RFC.asPrivate),
      salt: b64u(RFC.salt),
    });
    // 86-byte header, 41 bytes of text, the 0x02 delimiter and a 16-byte tag. (The example's
    // Content-Length line says 145, but the body it shows, and Appendix A, are 144 bytes.)
    expect(body.length).toBe(144);
    expect(body.toString("base64url")).toBe(b64u(RFC.body).toString("base64url"));
  });

  it("decrypts the RFC's example with the receiver's key", () => {
    const text = decryptPayload(b64u(RFC.body), { ...rfcKeys, privateKey: RFC.uaPrivate });
    expect(text.toString()).toBe(RFC.plaintext);
  });

  it("uses a new key and salt for every message", () => {
    const keys = browserKeys();
    const a = encryptPayload(Buffer.from("same"), keys);
    const b = encryptPayload(Buffer.from("same"), keys);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
    expect(decryptPayload(a, keys).toString()).toBe("same");
    expect(decryptPayload(b, keys).toString()).toBe("same");
  });

  it("only the subscribed browser can read it, and tampering is detected", () => {
    const keys = browserKeys();
    const other = browserKeys();
    const body = encryptPayload(Buffer.from("for one device"), keys);
    expect(() => decryptPayload(body, { ...keys, privateKey: other.privateKey })).toThrow();
    const tampered = Buffer.from(body);
    tampered[tampered.length - 20]! ^= 1;
    expect(() => decryptPayload(tampered, keys)).toThrow();
  });

  it("refuses messages over one record and malformed subscription keys", () => {
    const keys = browserKeys();
    expect(encryptPayload(Buffer.alloc(MAX_PLAINTEXT_BYTES), keys).length).toBe(4096);
    expect(() => encryptPayload(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1), keys)).toThrow(RangeError);
    expect(() => encryptPayload(Buffer.from("x"), { ...keys, auth: "c2hvcnQ" })).toThrow(/auth/);
    expect(() => encryptPayload(Buffer.from("x"), { ...keys, p256dh: keys.auth })).toThrow(
      /p256dh/,
    );
  });
});
