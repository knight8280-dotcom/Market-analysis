import { randomBytes } from "node:crypto";
import { stdin, stdout } from "node:process";
import { hashPassword } from "../src/server/auth/password";

/**
 * Prints the env lines for owner login: `pnpm web:hash-password`. The password is read without
 * echo (or from stdin when piped) and never written anywhere; only its scrypt hash is printed.
 */
async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

function readHidden(prompt: string): Promise<string> {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (input: string) => {
      for (const ch of input) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130); // Ctrl+C
        value = ch === "\u007f" ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  let password: string;
  if (stdin.isTTY) {
    password = await readHidden("Owner password (12+ characters): ");
    if ((await readHidden("Again: ")) !== password) throw new Error("The passwords differ.");
  } else {
    password = await readPiped();
  }
  const hash = await hashPassword(password);
  stdout.write(
    [
      "# Add to .env (never commit it). SESSION_SECRET only needs setting once;",
      "# changing either value signs out every session.",
      `OWNER_PASSWORD_HASH=${hash}`,
      `SESSION_SECRET=${randomBytes(32).toString("base64url")}`,
      "",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
