"use server";

import { loadWebEnv } from "@market/config";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeNext } from "../../server/auth/next-path";
import { verifyPassword } from "../../server/auth/password";
import {
  createSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "../../server/auth/session";
import { loginThrottle } from "../../server/auth/throttle";

function back(error: "wrong" | "locked", next: string): never {
  redirect(`/login?error=${error}&next=${encodeURIComponent(next)}`);
}

/**
 * Owner sign-in. Server Actions reject cross-origin posts, so the form needs no extra CSRF
 * token. Failures are throttled globally (one account) and the message never says why.
 */
export async function login(formData: FormData): Promise<void> {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  const next = safeNext(text("next"));
  const password = text("password");
  const throttle = loginThrottle();
  if (throttle.retryAfterMs() > 0) back("locked", next);

  const env = loadWebEnv();
  const ok =
    password.length > 0 &&
    password.length <= 1024 &&
    (await verifyPassword(password, env.OWNER_PASSWORD_HASH));
  if (!ok) {
    throttle.recordFailure();
    back("wrong", next);
  }
  throttle.reset();

  (await cookies()).set(
    SESSION_COOKIE,
    createSessionToken({
      sessionSecret: env.SESSION_SECRET,
      passwordHash: env.OWNER_PASSWORD_HASH,
    }),
    sessionCookieOptions((await headers()).get("origin")),
  );
  redirect(next);
}
