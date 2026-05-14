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
 *   • unhandledRejection — log loudly, KEEP RUNNING. A rejected
 *     fire-and-forget log write must not take down lead processing. The
 *     loud log makes it visible so the root cause still gets fixed.
 *   • uncaughtException  — log, then EXIT(1). After an uncaught throw the
 *     process state is undefined; serving from it risks corrupt writes.
 *     Railway restarts the service cleanly on a non-zero exit.
 *
 * Call once, as early as possible, in each entrypoint
 * (server/_core/index.ts and server/workers/run.ts).
 */
export function installGlobalErrorHandlers(processName: string): void {
  process.on("unhandledRejection", (reason: unknown) => {
    const detail =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? "(no stack)"}`
        : String(reason);
    console.error(
      `[${processName}] UNHANDLED REJECTION — logged, process kept alive:\n${detail}`,
    );
  });

  process.on("uncaughtException", (err: Error) => {
    console.error(
      `[${processName}] UNCAUGHT EXCEPTION — process state is undefined, exiting for a clean restart:`,
      err,
    );
    // Give stderr a tick to flush, then exit non-zero so Railway restarts us.
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100).unref();
  });

  console.log(`[${processName}] Global error handlers installed.`);
}
