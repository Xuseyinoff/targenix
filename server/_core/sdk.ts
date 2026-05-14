import { COOKIE_NAME, SESSION_EXPIRATION_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  name: string;
};

// ─── lastSignedIn throttle ────────────────────────────────────────────────────
// authenticateRequest() runs on EVERY tRPC call + every webhook auth check.
// Writing `users.lastSignedIn = NOW()` on each one means an active user with
// a polling UI burns ~50 writes/min on the users table, which dominates
// replication lag SLOs and shows up as a top write source on slow-query
// reports. The actual product requirement ("last seen within ~minutes") is
// fine with a 5-minute granularity.
//
// In-memory throttle: per-replica Map<openId, lastWriteMs>. Multi-replica
// production may still write up to (replica count) times per window, which
// is still 50-100x better than per-request. Map is bounded by active user
// count (~10k entries ≈ 1 MB at typical scale) and resets cleanly on
// process restart — no persistence needed.
const LAST_SIGNED_IN_THROTTLE_MS = 5 * 60 * 1000;
const lastSignedInThrottleMap = new Map<string, number>();

async function maybeUpdateLastSignedIn(openId: string): Promise<void> {
  const now = Date.now();
  const last = lastSignedInThrottleMap.get(openId);
  if (last !== undefined && now - last < LAST_SIGNED_IN_THROTTLE_MS) return;
  lastSignedInThrottleMap.set(openId, now);
  await db.upsertUser({ openId, lastSignedIn: new Date() });
}

class SDKServer {
  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) return new Map<string, string>();
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getSessionSecret() {
    return new TextEncoder().encode(ENV.cookieSecret);
  }

  /**
   * Create a signed JWT session token for a given user openId.
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string } = {}
  ): Promise<string> {
    return this.signSession(
      { openId, name: options.name ?? "" },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? SESSION_EXPIRATION_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    // `iat` is load-bearing: verifySession() compares it against the user's
    // `passwordChangedAt` to invalidate JWTs issued before a password reset.
    return new SignJWT({ openId: payload.openId, name: payload.name })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(Math.floor(issuedAt / 1000))
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<{ openId: string; name: string; iatMs: number | null } | null> {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, name, iat } = payload as Record<string, unknown>;

      if (!isNonEmptyString(openId)) {
        console.warn("[Auth] Session payload missing openId");
        return null;
      }

      const iatMs = typeof iat === "number" && Number.isFinite(iat) ? iat * 1000 : null;

      return {
        openId,
        name: isNonEmptyString(name) ? name : "",
        iatMs,
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  async authenticateRequest(req: Request): Promise<User> {
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);

    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }

    const user = await db.getUserByOpenId(session.openId);

    if (!user) {
      throw ForbiddenError("User not found");
    }

    // Reject JWTs issued before the user's last password reset. Stale
    // cookies from before the reset are no longer trusted, even though
    // they're cryptographically valid.
    if (user.passwordChangedAt && session.iatMs !== null) {
      const changedMs = user.passwordChangedAt.getTime();
      // Allow 1s of clock skew between the password-change write and the
      // JWT issued moments later by the reset handler itself.
      if (changedMs > session.iatMs + 1000) {
        console.warn("[Auth] Session predates password reset — rejecting", {
          openId: user.openId,
          iatMs: session.iatMs,
          changedMs,
        });
        throw ForbiddenError("Session expired — please sign in again");
      }
    }

    // Throttled — at most one DB write per user per 5-minute window per
    // replica. See maybeUpdateLastSignedIn() above for rationale.
    await maybeUpdateLastSignedIn(user.openId);

    return user;
  }
}

export const sdk = new SDKServer();
