import { describe, expect, it } from "vitest";
import { checkBasicAuth } from "../src/server/basic-auth";

const expected = { user: "ops", password: "a-long-enough-password" };
const header = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("checkBasicAuth", () => {
  it("accepts the right credentials", () => {
    expect(checkBasicAuth(header("ops", "a-long-enough-password"), expected)).toBe(true);
  });

  it("allows a colon inside the password", () => {
    expect(
      checkBasicAuth(header("ops", "pa:ss:word-1234567"), {
        user: "ops",
        password: "pa:ss:word-1234567",
      }),
    ).toBe(true);
  });

  it.each([
    ["no header", null],
    ["another scheme", "Bearer abc"],
    ["wrong user", header("admin", "a-long-enough-password")],
    ["wrong password", header("ops", "a-long-enough-passworD")],
    ["password prefix", header("ops", "a-long")],
    ["no colon", `Basic ${Buffer.from("opsonly").toString("base64")}`],
    ["garbage", "Basic !!!"],
  ])("rejects %s", (_name, value) => {
    expect(checkBasicAuth(value, expected)).toBe(false);
  });
});
