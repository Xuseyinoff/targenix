/**
 * Sentry initialization — Sprint 5 / Item 5.1.
 *
 * Activates only when `SENTRY_DSN` is set in the env. Without a DSN the
 * module is a no-op so local development and pre-DSN deploys keep
 * working exactly as before. Once a DSN is provided:
 *
 *   • Unhandled errors and rejections flow to Sentry with the
 *     environment tag (`NODE_ENV`) and release tag (Railway-provided
 *     RAILWAY_GIT_COMMIT_SHA when available).
 *   • The Express integration captures request context (URL, method,
 *     IP). Per-request user identity is attached by `captureUserScope`
 *     once tRPC resolves `ctx.user`.
 *   • A small set of high-signal hooks fire `Sentry.captureException`
 *     from places where we already detect critical failure but would
 *     otherwise rely on console logs (webhook DB write failures,
 *     order delivery exhaustion, SECURITY-category logs). Adapter
 *     errors stay logged but don't escalate by default — we'd flood
 *     Sentry with 401-retry-recover patterns otherwise.
 *
 * The `captureSecurityEvent` and `captureCritical` helpers are the
 * intended entry points for application code so we don't pepper the
 * codebase with vendor imports.
 */

import type { Express, NextFunction, Request, Response } from "express";

let _initialized = false;
let _Sentry: typeof import("@sentry/node") | null = null;

export function isSentryEnabled(): boolean {
  return _initialized && _Sentry !== null;
}

export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    console.log("[Sentry] SENTRY_DSN not set — telemetry disabled.");
    return;
  }
  if (_initialized) return;
  try {
    const Sentry = await import("@sentry/node");
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? "development",
      release:
        process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ??
        process.env.SENTRY_RELEASE ??
        undefined,
      // Sample 10% of transactions — enough to spot patterns without flooding.
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
      // Don't tag any field that could leak credentials.
      sendDefaultPii: false,
    });
    _Sentry = Sentry;
    _initialized = true;
    console.log(`[Sentry] initialized — env=${process.env.NODE_ENV}, release=${process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? "n/a"}`);
  } catch (err) {
    console.error("[Sentry] init failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Express error handler — wire AFTER all routes. Captures any error that
 * fell out of a route handler. No-op when Sentry isn't initialized.
 */
export function attachSentryExpressErrorHandler(app: Express): void {
  if (!isSentryEnabled() || !_Sentry) return;
  // Try the newer Express setup first (Sentry SDK v8+), fall back to v7 API.
  const sentryAny = _Sentry as unknown as {
    setupExpressErrorHandler?: (app: Express) => void;
    Handlers?: { errorHandler: () => (err: unknown, req: Request, res: Response, next: NextFunction) => void };
  };
  if (typeof sentryAny.setupExpressErrorHandler === "function") {
    sentryAny.setupExpressErrorHandler(app);
    return;
  }
  if (sentryAny.Handlers?.errorHandler) {
    app.use(sentryAny.Handlers.errorHandler());
  }
}

/**
 * Capture an exception that the caller has already decided is critical.
 * Examples: webhook durable insert failure, order delivery exhausted with
 * non-validation cause, SECURITY-category log already written.
 *
 * `context` lets the caller attach structured tags without importing
 * Sentry types into application code.
 */
export function captureCritical(
  err: unknown,
  context?: {
    tags?: Record<string, string | number | boolean | null>;
    user?: { id?: number | string; email?: string | null };
    extra?: Record<string, unknown>;
  },
): void {
  if (!isSentryEnabled() || !_Sentry) return;
  try {
    _Sentry.withScope((scope) => {
      if (context?.tags) {
        for (const [k, v] of Object.entries(context.tags)) {
          if (v === null || v === undefined) continue;
          scope.setTag(k, String(v));
        }
      }
      if (context?.user) {
        scope.setUser({
          id: context.user.id != null ? String(context.user.id) : undefined,
          email: context.user.email ?? undefined,
        });
      }
      if (context?.extra) {
        for (const [k, v] of Object.entries(context.extra)) {
          scope.setExtra(k, v);
        }
      }
      _Sentry!.captureException(err);
    });
  } catch {
    // Last-resort no-op: telemetry never breaks a real code path.
  }
}

/**
 * Capture a structured message (not an Error). Used by `log.error` when
 * the SECURITY category is hit — we want both the AdminLogs row AND a
 * Sentry event for cross-tenant attempts.
 */
export function captureSecurityEvent(
  message: string,
  context?: {
    tags?: Record<string, string | number | boolean | null>;
    user?: { id?: number | string };
    extra?: Record<string, unknown>;
  },
): void {
  if (!isSentryEnabled() || !_Sentry) return;
  try {
    _Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("category", "SECURITY");
      if (context?.tags) {
        for (const [k, v] of Object.entries(context.tags)) {
          if (v === null || v === undefined) continue;
          scope.setTag(k, String(v));
        }
      }
      if (context?.user?.id != null) {
        scope.setUser({ id: String(context.user.id) });
      }
      if (context?.extra) {
        for (const [k, v] of Object.entries(context.extra)) {
          scope.setExtra(k, v);
        }
      }
      _Sentry!.captureMessage(message);
    });
  } catch {
    // ignore
  }
}
