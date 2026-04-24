const KNOWN_TYPES = [
  "api_key",
  "telegram_bot",
  "google_sheets",
  "oauth2",
  "bearer",
];

function logTypeValidation(input: string, result: string) {
  if (process.env.TYPE_VALIDATION_LOG === "1") {
    console.log({
      stage: "type_validation",
      input,
      result,
    });
  }
}

/**
 * Normalizes and validates a value before it is written to `connections.type`.
 * Do not use on read paths — existing rows must always load.
 */
export function validateConnectionType(type: string): string {
  const t = (type ?? "").trim().toLowerCase();

  if (KNOWN_TYPES.includes(t)) {
    logTypeValidation(type, t);
    return t;
  }

  if (/^[a-z0-9_-]{3,32}$/.test(t)) {
    console.warn("Unknown connection type (allowed):", t);
    logTypeValidation(type, t);
    return t;
  }

  logTypeValidation(type, t);
  throw new Error("Invalid connection type");
}
