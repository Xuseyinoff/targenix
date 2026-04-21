/**
 * Unit tests for the dynamic-form validation module.
 *
 * All functions under test are pure; we run them in the default node
 * environment. No DOM, no tRPC, no React state — just data in, data out.
 */

import { describe, it, expect } from "vitest";
import type { ConfigField } from "./types";
import {
  collectDependentKeys,
  evaluateShowWhen,
  initialValueForField,
  isEmptyValue,
  isFieldVisible,
  validateField,
  validateFields,
} from "./validation";

const textField: ConfigField = {
  key: "title",
  type: "text",
  label: "Title",
  required: true,
  validation: { minLength: 3, maxLength: 10 },
};

const patternField: ConfigField = {
  key: "chat_id",
  type: "text",
  label: "Chat ID",
  validation: { pattern: "^-?\\d+$" },
};

const numberField: ConfigField = {
  key: "retries",
  type: "number",
  label: "Retries",
  validation: { min: 0, max: 5 },
};

const connectionField: ConfigField = {
  key: "connectionId",
  type: "connection-picker",
  label: "Connection",
  connectionType: "google_sheets",
  required: true,
};

const conditionalField: ConfigField = {
  key: "bot_token",
  type: "password",
  label: "Bot token",
  required: true,
  showWhen: { field: "auth_mode", equals: "inline" },
};

describe("isEmptyValue", () => {
  it("treats null, undefined, empty string, blank string as empty", () => {
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue("")).toBe(true);
    expect(isEmptyValue("   ")).toBe(true);
  });

  it("treats empty array and empty object as empty", () => {
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue({})).toBe(true);
  });

  it("does NOT treat 0 and false as empty", () => {
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(false)).toBe(false);
  });

  it("does NOT treat populated values as empty", () => {
    expect(isEmptyValue("x")).toBe(false);
    expect(isEmptyValue([1])).toBe(false);
    expect(isEmptyValue({ a: 1 })).toBe(false);
  });
});

describe("evaluateShowWhen", () => {
  it("matches equals rule", () => {
    expect(evaluateShowWhen({ field: "k", equals: "a" }, { k: "a" })).toBe(true);
    expect(evaluateShowWhen({ field: "k", equals: "a" }, { k: "b" })).toBe(false);
  });

  it("matches notEquals rule", () => {
    expect(evaluateShowWhen({ field: "k", notEquals: "a" }, { k: "b" })).toBe(true);
    expect(evaluateShowWhen({ field: "k", notEquals: "a" }, { k: "a" })).toBe(false);
  });

  it("matches `in` rule", () => {
    expect(evaluateShowWhen({ field: "k", in: ["a", "b"] }, { k: "a" })).toBe(true);
    expect(evaluateShowWhen({ field: "k", in: ["a", "b"] }, { k: "c" })).toBe(false);
  });

  it("treats malformed rule as visible (manifest validator already warned)", () => {
    // @ts-expect-error — intentionally malformed
    expect(evaluateShowWhen({ field: "k" }, { k: "a" })).toBe(true);
  });
});

describe("isFieldVisible", () => {
  it("is always true when showWhen is absent", () => {
    expect(isFieldVisible(textField, {})).toBe(true);
  });

  it("respects showWhen.equals", () => {
    expect(isFieldVisible(conditionalField, { auth_mode: "inline" })).toBe(true);
    expect(isFieldVisible(conditionalField, { auth_mode: "connection" })).toBe(false);
  });
});

describe("validateField", () => {
  it("required catches empty values", () => {
    expect(validateField(textField, "")).toBe("Title is required.");
    expect(validateField(textField, null)).toBe("Title is required.");
    expect(validateField(connectionField, null)).toBe("Connection is required.");
  });

  it("respects minLength and maxLength", () => {
    expect(validateField(textField, "ab")).toBe("Title must be at least 3 characters.");
    expect(validateField(textField, "abcdefghijk")).toBe("Title must be at most 10 characters.");
    expect(validateField(textField, "abcd")).toBeNull();
  });

  it("enforces pattern when provided", () => {
    expect(validateField(patternField, "abc")).toBe("Chat ID has an invalid format.");
    expect(validateField(patternField, "-123")).toBeNull();
  });

  it("tolerates malformed regex on the manifest", () => {
    const broken: ConfigField = { ...patternField, validation: { pattern: "(" } };
    expect(validateField(broken, "anything")).toBeNull();
  });

  it("enforces numeric min and max", () => {
    expect(validateField(numberField, -1)).toBe("Retries must be ≥ 0.");
    expect(validateField(numberField, 7)).toBe("Retries must be ≤ 5.");
    expect(validateField(numberField, 3)).toBeNull();
  });

  it("skips length/pattern/numeric checks for empty values", () => {
    const optional: ConfigField = { ...patternField, required: false };
    expect(validateField(optional, "")).toBeNull();
  });
});

describe("validateFields", () => {
  it("collects per-field errors and flips isValid", () => {
    const result = validateFields(
      [textField, numberField, connectionField],
      { title: "", retries: 99, connectionId: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.title).toContain("required");
    expect(result.errors.retries).toContain("≤ 5");
    expect(result.errors.connectionId).toBeUndefined();
  });

  it("reports isValid=true when all pass", () => {
    const result = validateFields(
      [textField, numberField, connectionField],
      { title: "hello", retries: 2, connectionId: 7 },
    );
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it("skips validation for fields hidden by showWhen", () => {
    const result = validateFields([conditionalField], { auth_mode: "connection" });
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it("still validates hidden-by-default fields once their showWhen matches", () => {
    const result = validateFields([conditionalField], { auth_mode: "inline" });
    expect(result.errors.bot_token).toBe("Bot token is required.");
  });
});

describe("initialValueForField", () => {
  it("honours explicit defaultValue", () => {
    const f: ConfigField = { ...textField, defaultValue: "seed" };
    expect(initialValueForField(f)).toBe("seed");
  });

  it("returns type-appropriate blanks", () => {
    expect(initialValueForField({ key: "t", type: "text", label: "t" })).toBe("");
    expect(initialValueForField({ key: "n", type: "number", label: "n" })).toBeNull();
    expect(initialValueForField({ key: "b", type: "boolean", label: "b" })).toBe(false);
    expect(initialValueForField({ key: "m", type: "multi-select", label: "m" })).toEqual([]);
    expect(initialValueForField({ key: "fm", type: "field-mapping", label: "fm" })).toEqual({});
  });
});

describe("collectDependentKeys", () => {
  const fields: ConfigField[] = [
    { key: "connectionId", type: "connection-picker", label: "conn" },
    {
      key: "spreadsheetId",
      type: "async-select",
      label: "ss",
      dependsOn: ["connectionId"],
    },
    {
      key: "sheetName",
      type: "async-select",
      label: "sheet",
      dependsOn: ["connectionId", "spreadsheetId"],
    },
    {
      key: "mapping",
      type: "field-mapping",
      label: "map",
      dependsOn: ["connectionId", "spreadsheetId", "sheetName"],
    },
  ];

  it("finds direct dependents", () => {
    expect(collectDependentKeys(fields, "sheetName")).toEqual(["mapping"]);
  });

  it("walks transitively and keeps manifest order", () => {
    expect(collectDependentKeys(fields, "connectionId")).toEqual([
      "spreadsheetId",
      "sheetName",
      "mapping",
    ]);
    expect(collectDependentKeys(fields, "spreadsheetId")).toEqual([
      "sheetName",
      "mapping",
    ]);
  });

  it("returns empty when nothing depends on the key", () => {
    expect(collectDependentKeys(fields, "mapping")).toEqual([]);
  });

  it("is safe against accidental cycles in a manifest", () => {
    const cyclic: ConfigField[] = [
      { key: "a", type: "text", label: "A", dependsOn: ["b"] },
      { key: "b", type: "text", label: "B", dependsOn: ["a"] },
    ];
    // Starting from "a", "b" depends on "a", "a" depends on "b" — both visited once.
    const result = collectDependentKeys(cyclic, "a");
    expect(result).toContain("b");
    // Must terminate (implicit: test not timing out)
  });
});
