import { Button, Card, Input } from "@market/ui";
import type { Metadata } from "next";
import { BRAND } from "../../brand";
import { safeNext } from "../../server/auth/next-path";
import { login } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  wrong: "That password is not right.",
  locked: "Too many attempts. Wait 15 minutes, then try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : null);
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold">{BRAND}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Private. Sign in to continue.</p>
        <form action={login} className="mt-6 flex flex-col gap-3">
          <input type="hidden" name="next" value={next} />
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
          {error ? (
            <p id="login-error" role="alert" className="text-sm text-down">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" className="mt-2">
            Sign in
          </Button>
        </form>
      </Card>
    </main>
  );
}
