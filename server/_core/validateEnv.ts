/**
 * validateEnv.ts — Startup environment validation.
 *
 * Called as the very first thing in server startup.
 * Kills the process immediately if any required variable is missing or malformed.
 * Prevents silent misconfiguration bugs in production.
 */

const REQUIRED = [
  "DATABASE_URL",
  "APP_URL",
  "FACEBOOK_APP_SECRET",
  "FACEBOOK_VERIFY_TOKEN",
  "ENCRYPTION_KEY",
  "JWT_SECRET",
] as const;

export function validateEnv(): void {
  const missing: string[] = [];

  for (const key of REQUIRED) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error("[startup] FATAL: Missing required environment variables:", missing.join(", "));
    console.error("[startup] Check your .env file or Railway Variables dashboard.");
    process.exit(1);
  }

  if (process.env.ENCRYPTION_KEY!.length !== 32) {
    console.error(
      `[startup] FATAL: ENCRYPTION_KEY must be exactly 32 characters (got ${process.env.ENCRYPTION_KEY!.length}). ` +
      "Changing this in production will break all stored Facebook tokens."
    );
    process.exit(1);
  }

  if (process.env.JWT_SECRET!.length < 32) {
    console.error(
      `[startup] FATAL: JWT_SECRET must be at least 32 characters (got ${process.env.JWT_SECRET!.length}). ` +
      "Short secrets can be brute-forced."
    );
    process.exit(1);
  }

  if (
    process.env.NODE_ENV === "production" &&
    !process.env.APP_URL!.startsWith("https://")
  ) {
    console.error(
      "[startup] FATAL: APP_URL must start with https:// in production. " +
      `Got: ${process.env.APP_URL}`
    );
    process.exit(1);
  }

  console.log("[startup] Environment validation passed ✓");
}
