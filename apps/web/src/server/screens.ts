import "server-only";
import { OWNER_USER_ID } from "@market/config";
import { parseScreen, type Screen } from "@market/screener";
import { db } from "./db";

/** A screen in a URL: base64url JSON. Invalid input gives null, never an exception. */
export function decodeScreen(param: string | undefined): Screen | null {
  if (!param || param.length > 8000) return null;
  try {
    return parseScreen(JSON.parse(Buffer.from(param, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export function encodeScreen(screen: Screen): string {
  return Buffer.from(JSON.stringify(screen)).toString("base64url");
}

export async function savedScreens(): Promise<{ id: string; name: string; screen: Screen }[]> {
  const rows = await db()
    .selectFrom("saved_screens")
    .select(["screen_id", "name", "definition"])
    .where("user_id", "=", OWNER_USER_ID)
    .orderBy("name")
    .execute();
  return rows.flatMap((r) => {
    try {
      return [{ id: r.screen_id, name: r.name, screen: parseScreen(r.definition) }];
    } catch {
      return []; // a definition from an older schema that no longer validates
    }
  });
}
