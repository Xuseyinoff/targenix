import { describe, expect, it } from "vitest";
import {
  FB_METADATA_FIELDS,
  NAME_PATTERNS,
  PHONE_PATTERNS,
  TEMPLATE_VARIABLE_FIELDS,
  autoMatchField,
  createEmptyExtraField,
  hydrateExtraFields,
  isKnownFormOrMetaFieldKey,
  serializeExtraFields,
} from "./shared";

describe("autoMatchField", () => {
  it("matches the first field whose key contains a pattern (case-insensitive)", () => {
    const fields = [{ key: "EMAIL" }, { key: "FullName" }, { key: "telefon" }];
    expect(autoMatchField(fields, NAME_PATTERNS)).toBe("FullName");
    expect(autoMatchField(fields, PHONE_PATTERNS)).toBe("telefon");
  });

  it("returns an empty string when nothing matches", () => {
    expect(autoMatchField([{ key: "address" }], NAME_PATTERNS)).toBe("");
  });

  it("handles an empty field list", () => {
    expect(autoMatchField([], NAME_PATTERNS)).toBe("");
  });

  it("recognises Cyrillic name patterns", () => {
    expect(autoMatchField([{ key: "Имя_клиента" }], NAME_PATTERNS)).toBe(
      "Имя_клиента",
    );
  });
});

describe("serializeExtraFields", () => {
  it("drops rows with blank destKey and trims destKey whitespace", () => {
    const out = serializeExtraFields([
      {
        destKey: "  name  ",
        sourceType: "form",
        sourceField: "full_name",
      },
      { destKey: "", sourceType: "form", sourceField: "ignored" },
    ]);
    expect(out).toEqual([
      { destKey: "name", sourceField: "full_name", staticValue: undefined },
    ]);
  });

  it("emits only staticValue (trimmed) for static rows, only sourceField for form rows", () => {
    const out = serializeExtraFields([
      { destKey: "utm", sourceType: "static", staticValue: "  meta  " },
      { destKey: "phone", sourceType: "form", sourceField: "phone_number" },
    ]);
    expect(out).toEqual([
      { destKey: "utm", sourceField: undefined, staticValue: "meta" },
      { destKey: "phone", sourceField: "phone_number", staticValue: undefined },
    ]);
  });
});

describe("hydrateExtraFields", () => {
  it("returns an empty array for non-array input", () => {
    expect(hydrateExtraFields(null)).toEqual([]);
    expect(hydrateExtraFields("weird")).toEqual([]);
    expect(hydrateExtraFields({ foo: 1 })).toEqual([]);
  });

  it("detects sourceType=static when staticValue is present, form otherwise", () => {
    const out = hydrateExtraFields([
      { destKey: "a", sourceField: "x" },
      { destKey: "b", staticValue: "y" },
      { destKey: "c" },
    ]);
    expect(out[0].sourceType).toBe("form");
    expect(out[1].sourceType).toBe("static");
    expect(out[2].sourceType).toBe("form");
  });

  it("is resilient to missing / non-string fields", () => {
    const out = hydrateExtraFields([{}]);
    expect(out).toEqual([
      { destKey: "", sourceType: "form", sourceField: "", staticValue: "" },
    ]);
  });

  it("round-trips through serializeExtraFields", () => {
    const original = [
      { destKey: "offer_id", sourceField: "offer_id" },
      { destKey: "note", staticValue: "hi" },
    ];
    const hydrated = hydrateExtraFields(original);
    const serialized = serializeExtraFields(hydrated);
    expect(serialized).toEqual([
      { destKey: "offer_id", sourceField: "offer_id", staticValue: undefined },
      { destKey: "note", sourceField: undefined, staticValue: "hi" },
    ]);
  });
});

describe("isKnownFormOrMetaFieldKey", () => {
  const formFields = [{ key: "full_name" }, { key: "email" }];

  it("matches a form field", () => {
    expect(isKnownFormOrMetaFieldKey("full_name", formFields)).toBe(true);
  });

  it("matches an FB metadata field", () => {
    expect(isKnownFormOrMetaFieldKey("ad_name", formFields)).toBe(true);
  });

  it("returns false for unknown / blank keys", () => {
    expect(isKnownFormOrMetaFieldKey("", formFields)).toBe(false);
    expect(isKnownFormOrMetaFieldKey("   ", formFields)).toBe(false);
    expect(isKnownFormOrMetaFieldKey("foobar", formFields)).toBe(false);
  });
});

describe("createEmptyExtraField", () => {
  it("starts in manual-source mode so typed keys aren't auto-cleared by Radix Select", () => {
    const row = createEmptyExtraField();
    expect(row.manualSource).toBe(true);
    expect(row.sourceType).toBe("form");
    expect(row.destKey).toBe("");
  });
});

describe("TEMPLATE_VARIABLE_FIELDS", () => {
  it("exposes required variables for sotuvchi + 100k templates", () => {
    expect(TEMPLATE_VARIABLE_FIELDS.sotuvchi.every((f) => f.required)).toBe(true);
    expect(TEMPLATE_VARIABLE_FIELDS["100k"].every((f) => f.required)).toBe(true);
  });

  it("custom template has no fixed variable fields", () => {
    expect(TEMPLATE_VARIABLE_FIELDS.custom).toEqual([]);
  });
});

describe("FB_METADATA_FIELDS", () => {
  it("covers all keys the old wizard used to expose", () => {
    const keys = FB_METADATA_FIELDS.map((f) => f.key);
    expect(keys).toEqual([
      "lead_id",
      "form_id",
      "ad_id",
      "ad_name",
      "adset_id",
      "adset_name",
      "campaign_id",
      "campaign_name",
    ]);
  });
});
