import { eq, lt } from "drizzle-orm";
import { oauthStates } from "../../drizzle/schema";
import type { DbClient } from "../db";
import type { OAuthMode } from "./types";

const TTL_MS = 10 * 60 * 1000;

export function generateOAuthStateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function insertOAuthState(
  db: DbClient,
  input: {
    state: string;
    userId: number;
    provider: string;
    mode: OAuthMode;
    appKey: string | null;
  },
): Promise<void> {
  await db.insert(oauthStates).values({
    state: input.state,
    userId: input.userId,
    provider: input.provider,
    mode: input.mode,
    appKey: input.appKey,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
}

export async function consumeOAuthState(
  db: DbClient,
  stateParam: string,
): Promise<{
  id: number;
  userId: number;
  provider: string;
  mode: OAuthMode;
  appKey: string | null;
} | null> {
  const [row] = await db
    .select()
    .from(oauthStates)
    .where(eq(oauthStates.state, stateParam))
    .limit(1);
  if (!row) return null;
  if (new Date() > row.expiresAt) {
    await db.delete(oauthStates).where(eq(oauthStates.id, row.id));
    return null;
  }
  await db.delete(oauthStates).where(eq(oauthStates.id, row.id));
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    mode: row.mode as OAuthMode,
    appKey: row.appKey,
  };
}

export function scheduleCleanupExpiredStates(dbPromise: Promise<DbClient | null>): void {
  dbPromise
    .then((db) => {
      if (!db) return;
      return db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
    })
    .catch(() => {});
}
