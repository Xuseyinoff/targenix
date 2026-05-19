/**
 * fbTokenRefreshScheduler — proactive refresh of Facebook user access tokens.
 *
 * Background:
 *   Facebook long-lived user tokens expire after 60 days. Before this
 *   scheduler each user had to click "Reconnect" on the Connections page on
 *   their own schedule; if they forgot, the next lead webhook hit a 401
 *   from Graph and the lead silently failed (the 2026-05-19 failed-leads
 *   sprint now surfaces that failure with a Telegram alert, but the root
 *   cause is still that nobody was refreshing the token).
 *
 *   This scheduler shifts the problem left: every 24h we look for tokens
 *   that will expire within `REFRESH_AHEAD_DAYS`, call FB's
 *   `fb_exchange_token` to get a fresh 60-day token, and persist it. The
 *   user never has to think about Reconnect again unless the underlying
 *   FB grant is actually revoked.
 *
 * Design notes:
 *   - Cadence: 24h. The 60-day token lifecycle is leisurely; daily refresh
 *     of due rows comfortably hits every account well before it lapses.
 *   - Boot delay: 10 min — staggered after the other schedulers so we
 *     don't pile FB calls on top of boot-time work.
 *   - Threshold: 14 days (not 7). A one-day scheduler outage during the
 *     "last 7 days" window would put an account in the danger zone; 14
 *     days gives us 7 days of slack.
 *   - Order: tokens nearest to expiry first (ASC by tokenExpiresAt). If a
 *     tick is killed midway, the highest-risk accounts already went.
 *   - Concurrency: 3 parallel FB calls (configurable). FB's
 *     `/oauth/access_token` is generous; we're nowhere near rate limits
 *     at current scale.
 *   - Overlap guard: `_running` flag matches `connectionHealthScheduler`.
 *   - Feature flag: `FB_TOKEN_REFRESH_ENABLED=false` default. Lets us
 *     deploy dark, observe one no-op boot in Railway logs, then flip on.
 *
 * Error handling (classified via `classifyGraphError`):
 *   - success                                 → UPDATE token + tokenExpiresAt
 *   - rate_limit / network (transient)        → skip this tick, retry tomorrow
 *   - auth / validation / permanently_missing → token is dead. Mark
 *     `tokenExpiresAt = NOW()` so the UI badge surfaces "Reconnect needed"
 *     and log loudly to Railway for triage. Phase 2B (next sprint) layers
 *     a Telegram alert to the user's system chat on top of this.
 *
 * This file is Phase 2A — scheduler core ONLY. No Telegram code lives
 * here yet; that lands in Phase 2B once we've observed one healthy tick
 * in production.
 */

import { and, asc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { facebookAccounts } from "../../drizzle/schema";
import { getDb } from "../db";
import { decrypt, encrypt } from "../encryption";
import { exchangeForLongLivedToken } from "./facebookGraphService";
import {
  classifyGraphError,
  type GraphErrorType,
} from "../lib/leadEnrichmentRetryPolicy";
import { log } from "./appLogger";
import { envBool, envInt } from "../lib/envHelpers";
import { newSchedulerTraceId, runWithRequestContext } from "../lib/requestContext";

/** Refresh tokens that expire within this window from now. */
const REFRESH_AHEAD_DAYS = envInt("FB_TOKEN_REFRESH_AHEAD_DAYS", 14);

/** Cycle interval. 24h matches the 60-day lifecycle gracefully. */
const TICK_INTERVAL_MS = envInt("FB_TOKEN_REFRESH_TICK_MS", 24 * 60 * 60 * 1000);

/** First-tick delay after boot — long enough to clear boot-time work. */
const BOOT_DELAY_MS = envInt("FB_TOKEN_REFRESH_BOOT_DELAY_MS", 10 * 60 * 1000);

/** Parallel FB calls. 3 is comfortable below any documented rate limit. */
const CONCURRENCY = envInt("FB_TOKEN_REFRESH_CONCURRENCY", 3);

let _running = false;
let _bootTimer: ReturnType<typeof setTimeout> | null = null;
let _tickTimer: ReturnType<typeof setInterval> | null = null;

export interface FbTokenRefreshResult {
  /** Rows matched by the due-query (the work queue size for this tick). */
  scanned: number;
  /** Tokens successfully exchanged + persisted. */
  refreshed: number;
  /** Unexpected failures (DB error, decrypt failure, etc.). */
  failed: number;
  /** Transient errors — rate_limit / network. Will retry next tick naturally. */
  skipped: number;
  /** Permanent failures — auth / validation / permanently_missing. Marked expired so the UI prompts the user to Reconnect. */
  dead: number;
}

/**
 * Reusable empty-result shape. Helpers + the early-DB-missing path return
 * a copy of this — using Object.freeze would prevent mutation later, so
 * we just inline new copies.
 */
function emptyResult(): FbTokenRefreshResult {
  return { scanned: 0, refreshed: 0, failed: 0, skipped: 0, dead: 0 };
}

/**
 * Peel FB error metadata off whatever `exchangeForLongLivedToken` (via
 * `graphRequest`) re-threw. `graphRequest` preserves the axios error
 * shape — we use the same extraction as `processLead` so the classifier
 * gets identical inputs in both code paths.
 */
function extractFbErrorFields(err: unknown): {
  httpStatus?: number;
  fbErrorCode?: number;
  fbErrorSubcode?: number;
  message: string;
} {
  const e = err as {
    response?: { status?: number; data?: unknown };
    message?: string;
  };
  const fb = (e?.response?.data as {
    error?: { message?: string; code?: number; error_subcode?: number };
  })?.error;
  return {
    httpStatus: e?.response?.status,
    fbErrorCode: fb?.code,
    fbErrorSubcode: fb?.error_subcode,
    message: fb?.message ?? e?.message ?? "Unknown error",
  };
}

/**
 * Read FB app credentials from env. Mirrors the (non-exported)
 * `getAppCredentials` helper in `facebookAccountsRouter.ts`. Throws if
 * unset — the scheduler caller catches and treats this as a fatal config
 * problem (we never reach the per-account loop).
 */
function readAppCredentials(): { appId: string; appSecret: string } {
  const appId = (process.env.FACEBOOK_APP_ID ?? "").trim();
  const appSecret = (process.env.FACEBOOK_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) {
    throw new Error(
      "FB_TOKEN_REFRESH: FACEBOOK_APP_ID and FACEBOOK_APP_SECRET must be set",
    );
  }
  return { appId, appSecret };
}

/**
 * One pass over the due-account list. Exported for tests + ops debugging.
 * Caller is responsible for the `_running` guard.
 */
export async function runFbTokenRefreshTick(opts?: {
  now?: Date;
}): Promise<FbTokenRefreshResult> {
  const now = opts?.now ?? new Date();
  const horizon = new Date(now.getTime() + REFRESH_AHEAD_DAYS * 24 * 60 * 60 * 1000);

  const db = await getDb();
  if (!db) {
    await log.warn("FACEBOOK", "[FbTokenRefresh] DB unavailable — skipping tick");
    return emptyResult();
  }

  let creds: { appId: string; appSecret: string };
  try {
    creds = readAppCredentials();
  } catch (err) {
    await log.error(
      "FACEBOOK",
      "[FbTokenRefresh] App credentials missing — skipping tick",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return emptyResult();
  }

  // Due query — only rows with a known expiry that's in the next
  // REFRESH_AHEAD_DAYS days AND not already in the past. Already-expired
  // tokens can't be refreshed (FB rejects `fb_exchange_token` for them);
  // those users must hit Reconnect manually.
  const due = await db
    .select()
    .from(facebookAccounts)
    .where(
      and(
        isNotNull(facebookAccounts.tokenExpiresAt),
        lt(facebookAccounts.tokenExpiresAt, horizon),
        gte(facebookAccounts.tokenExpiresAt, now),
      ),
    )
    .orderBy(asc(facebookAccounts.tokenExpiresAt));

  const result = emptyResult();
  result.scanned = due.length;

  if (due.length === 0) {
    await log.info(
      "FACEBOOK",
      "[FbTokenRefresh] No accounts due for refresh",
      { horizon: horizon.toISOString(), aheadDays: REFRESH_AHEAD_DAYS },
    );
    return result;
  }

  await log.info(
    "FACEBOOK",
    `[FbTokenRefresh] Tick starting — ${due.length} accounts due`,
    {
      dueCount: due.length,
      aheadDays: REFRESH_AHEAD_DAYS,
      concurrency: CONCURRENCY,
      horizon: horizon.toISOString(),
    },
  );

  // Bounded concurrency — N workers draining a shared queue. Each
  // worker swallows its own per-account errors so a single bad row
  // never poisons the rest. `allSettled` is the outer guard against
  // any unexpected throw outside the inner try/catch.
  const queue = [...due];
  const work = async (): Promise<void> => {
    while (queue.length > 0) {
      const account = queue.shift();
      if (!account) break;
      try {
        await refreshOneAccount(db, account, creds, result);
      } catch (err) {
        // Defensive: refreshOneAccount already catches everything we
        // expect (Graph errors, DB errors). This branch only fires for
        // bugs — count them as `failed` and keep going.
        result.failed++;
        await log.error(
          "FACEBOOK",
          `[FbTokenRefresh] Unexpected throw for account ${account.id}`,
          {
            accountId: account.id,
            userId: account.userId,
            error: err instanceof Error ? err.message : String(err),
          },
          null,
          null,
          account.userId,
        );
      }
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(CONCURRENCY, due.length); i++) {
    workers.push(work());
  }
  await Promise.allSettled(workers);

  await log.info("FACEBOOK", "[FbTokenRefresh] Tick complete", { ...result });
  return result;
}

type FacebookAccountRow = typeof facebookAccounts.$inferSelect;

async function refreshOneAccount(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  account: FacebookAccountRow,
  creds: { appId: string; appSecret: string },
  result: FbTokenRefreshResult,
): Promise<void> {
  let currentToken: string;
  try {
    currentToken = decrypt(account.accessToken);
  } catch (err) {
    // The encrypted blob is unreadable — probably an ENCRYPTION_KEY
    // rotation happened. Counts as `failed` (not `dead`) because the
    // user CAN recover by re-Reconnecting, which would re-encrypt.
    result.failed++;
    await log.error(
      "FACEBOOK",
      `[FbTokenRefresh] decrypt failed for account ${account.id}`,
      {
        accountId: account.id,
        userId: account.userId,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      null,
      account.userId,
    );
    return;
  }

  let exchanged: Awaited<ReturnType<typeof exchangeForLongLivedToken>>;
  try {
    exchanged = await exchangeForLongLivedToken(
      currentToken,
      creds.appId,
      creds.appSecret,
    );
  } catch (err) {
    const fb = extractFbErrorFields(err);
    const errorType: GraphErrorType = classifyGraphError(fb);
    await handleRefreshFailure({
      db,
      account,
      errorType,
      message: fb.message,
      result,
    });
    return;
  }

  // FB returned a fresh token. The bfeaf23 fix taught us that `expires_in`
  // can come back as 0 for never-expiring tokens (business accounts); we
  // persist that as NULL so the due-query naturally skips this row from
  // now on.
  const newExpiresAt =
    exchanged.expires_in && exchanged.expires_in > 0
      ? new Date(Date.now() + exchanged.expires_in * 1000)
      : null;

  await db
    .update(facebookAccounts)
    .set({
      accessToken: encrypt(exchanged.access_token),
      tokenExpiresAt: newExpiresAt,
    })
    .where(eq(facebookAccounts.id, account.id));

  result.refreshed++;
  await log.info(
    "FACEBOOK",
    `[FbTokenRefresh] Refreshed account ${account.id}`,
    {
      accountId: account.id,
      userId: account.userId,
      fbUserName: account.fbUserName,
      previousExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
      newExpiresAt: newExpiresAt?.toISOString() ?? null,
    },
    null,
    null,
    account.userId,
  );
}

async function handleRefreshFailure(params: {
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  account: FacebookAccountRow;
  errorType: GraphErrorType;
  message: string;
  result: FbTokenRefreshResult;
}): Promise<void> {
  const { db, account, errorType, message, result } = params;

  if (errorType === "rate_limit" || errorType === "network") {
    result.skipped++;
    await log.warn(
      "FACEBOOK",
      `[FbTokenRefresh] Transient ${errorType} for account ${account.id} — will retry next tick`,
      {
        accountId: account.id,
        userId: account.userId,
        errorType,
        fbErrorMessage: message,
      },
      null,
      null,
      account.userId,
    );
    return;
  }

  // auth / validation / permanently_missing — token is dead. Mark the
  // row as already-expired so the UI badge reads "Reconnect needed" and
  // the due-query skips it on future ticks (we never refresh expired
  // tokens — FB would reject anyway).
  //
  // Phase 2B will add a Telegram alert to the user's system chat from
  // this branch.
  result.dead++;
  await db
    .update(facebookAccounts)
    .set({ tokenExpiresAt: new Date() })
    .where(eq(facebookAccounts.id, account.id));

  await log.error(
    "FACEBOOK",
    `[FbTokenRefresh] Token dead for account ${account.id} (${errorType}) — user must Reconnect`,
    {
      accountId: account.id,
      userId: account.userId,
      fbUserName: account.fbUserName,
      errorType,
      fbErrorMessage: message,
    },
    null,
    null,
    account.userId,
  );
}

async function runTickGuarded(): Promise<void> {
  if (_running) {
    await log.info(
      "FACEBOOK",
      "[FbTokenRefresh] Previous tick still running — skipping",
    );
    return;
  }
  _running = true;
  try {
    await runWithRequestContext(
      {
        traceId: newSchedulerTraceId("fb-token-refresh"),
        kind: "scheduler",
        name: "fb-token-refresh",
      },
      () => runFbTokenRefreshTick(),
    );
  } catch (err) {
    // runFbTokenRefreshTick already catches every per-account error;
    // this catch is the last-resort net for outer bugs (e.g. db.select
    // throwing). Log and continue — the scheduler must never crash.
    await log.error(
      "FACEBOOK",
      "[FbTokenRefresh] Tick threw at outer scope — scheduler continues",
      { error: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    _running = false;
  }
}

/**
 * Start the scheduler. Idempotent — second call no-ops. Honours the
 * `FB_TOKEN_REFRESH_ENABLED` feature flag so we can deploy dark.
 */
export function startFbTokenRefreshScheduler(): void {
  if (!envBool("FB_TOKEN_REFRESH_ENABLED", false)) {
    void log.info(
      "FACEBOOK",
      "[FbTokenRefresh] Scheduler disabled by feature flag (FB_TOKEN_REFRESH_ENABLED)",
    );
    return;
  }
  if (_bootTimer || _tickTimer) {
    void log.warn(
      "FACEBOOK",
      "[FbTokenRefresh] Already started — start call ignored",
    );
    return;
  }

  void log.info("FACEBOOK", "[FbTokenRefresh] Starting", {
    bootDelayMinutes: BOOT_DELAY_MS / 60_000,
    tickIntervalHours: TICK_INTERVAL_MS / (60 * 60_000),
    aheadDays: REFRESH_AHEAD_DAYS,
    concurrency: CONCURRENCY,
  });

  _bootTimer = setTimeout(() => {
    _bootTimer = null;
    void runTickGuarded();
    _tickTimer = setInterval(() => void runTickGuarded(), TICK_INTERVAL_MS);
  }, BOOT_DELAY_MS);
}

/** Cancel pending timers. Safe to call when scheduler isn't running. */
export function stopFbTokenRefreshScheduler(): void {
  if (_bootTimer) {
    clearTimeout(_bootTimer);
    _bootTimer = null;
  }
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}

/** Test-only — clear the in-flight guard between cases. */
export function _resetFbTokenRefreshState(): void {
  _running = false;
  if (_bootTimer) {
    clearTimeout(_bootTimer);
    _bootTimer = null;
  }
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}
