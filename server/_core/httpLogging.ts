type LoggedPayloadSummary =
  | {
      kind: "object";
      keyCount: number;
      keys: string[];
      redacted: true;
    }
  | {
      kind: "array";
      length: number;
      redacted: true;
    }
  | {
      kind: "string";
      length: number;
      redacted: true;
    }
  | {
      kind: "primitive";
      valueType: "number" | "boolean" | "bigint";
      redacted: true;
    };

const MAX_LOGGED_KEYS = 10;

export function summarizeRequestPayload(
  payload: unknown
): LoggedPayloadSummary | undefined {
  if (payload === null || payload === undefined) {
    return undefined;
  }

  if (Array.isArray(payload)) {
    return {
      kind: "array",
      length: payload.length,
      redacted: true,
    };
  }

  if (typeof payload === "object") {
    const keys = Object.keys(payload as Record<string, unknown>);

    if (keys.length === 0) {
      return undefined;
    }

    return {
      kind: "object",
      keyCount: keys.length,
      keys: keys.slice(0, MAX_LOGGED_KEYS),
      redacted: true,
    };
  }

  if (typeof payload === "string") {
    if (payload.length === 0) {
      return undefined;
    }

    return {
      kind: "string",
      length: payload.length,
      redacted: true,
    };
  }

  if (
    typeof payload === "number" ||
    typeof payload === "boolean" ||
    typeof payload === "bigint"
  ) {
    const valueType =
      typeof payload === "number"
        ? "number"
        : typeof payload === "boolean"
          ? "boolean"
          : "bigint";

    return {
      kind: "primitive",
      valueType,
      redacted: true,
    };
  }

  return undefined;
}
