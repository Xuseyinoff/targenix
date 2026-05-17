/**
 * Process-level safety net for unhandled async errors.
 *
 * The codebase fires a lot of `void log.x(...)` / `void someAsync()` —
 * deliberate fire-and-forget calls. Without these handlers, a single
 * rejected fire-and-forget promise either crashes the process (Node 15+
 * default for unhandledRejection) or silently degrades it. Neither is
 * acceptable for a process that's draining a lead queue.
 *
 * Policy:
 *   • unhandledRejection — log loudly, capture to Sentry, KEEP RUNNING.
 *     A rejected fire-and-forget log write must not take down lead
 *     processing. The loud log + Sentry event make it visible so the
 *     root cause still gets fixed.
 *   • uncaughtException  — log, capture to Sentry, flush, then EXIT(1).
 *     After an uncaught throw the process state is undefined; serving
 *     from it risks corrupt writes. Railway restarts the service cleanly
 *     on a non-zero exit. The Sentry flush is capped at 2s so a hung
 *     Sentry never blocks the restart.
 *
 * Call once, as early as possible, in each entrypoint
 * (server/_core/index.ts and server/workers/run.ts).
 *
 * Sentry coupling: this module uses the encapsulated helpers from
 * `../monitoring/sentry` — both are graceful no-ops when SENTRY_DSN is
 * unset, so the handlers behave identically in local dev.
 */
import { captureCritical, flushSentry } from "../monitoring/sentry";

export function installGlobalErrorHandlers(processName: string): void {
  process.on("unhandledRejection", (reason: unknown) => {
    const detail =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? "(no stack)"}`
        : String(reason);
    console.error(
      `[${processName}] UNHANDLED REJECTION — logged, process kept alive:\n${detail}`,
    );
    captureCritical(reason, {
      tags: { handler: "unhandledRejection", process: processName },
    });
  });

  process.on("uncaughtException", (err: Error) => {
    console.error(
      `[${processName}] UNCAUGHT EXCEPTION — process state is undefined, exiting for a clean restart:`,
      err,
    );
    captureCritical(err, {
      tags: { handler: "uncaughtException", process: processName },
    });
    process.exitCode = 1;
    // Flush Sentry (capped, no-op when uninit) and stderr together, then
    // exit non-zero so Railway restarts us. The setTimeout fallback fires
    // if Sentry resolves slower than 2.1s for any reason.
    void flushSentry(2000).finally(() => {
      setTimeout(() => process.exit(1), 100).unref();
    });
  });

  console.log(`[${processName}] Global error handlers installed.`);
}
