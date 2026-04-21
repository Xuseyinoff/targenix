import { describe, expect, it } from "vitest";
import type { AppManifest } from "./manifest";
import { validateManifestFields } from "./manifestValidation";

/**
 * Builds a minimally valid manifest for testing. Tests override only the
 * fields relevant to the case they exercise.
 */
function makeManifest(overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    key: "test-app",
    name: "Test",
    version: "1.0.0",
    category: "other",
    adapterKey: "test-adapter",
    connectionType: "none",
    modules: [],
    availability: "stable",
    ...overrides,
  };
}

describe("validateManifestFields", () => {
  it("returns no problems for a manifest with no fields[]", () => {
    const m = makeManifest({
      modules: [{ key: "m1", name: "M1", kind: "action" }],
    });
    expect(validateManifestFields(m)).toEqual([]);
  });

  it("returns no problems for a well-formed module", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [
            { key: "name", type: "text", label: "Name", required: true },
            {
              key: "kind",
              type: "select",
              label: "Kind",
              options: [
                { value: "a", label: "A" },
                { value: "b", label: "B" },
              ],
            },
          ],
        },
      ],
    });
    expect(validateManifestFields(m)).toEqual([]);
  });

  it("flags duplicate field keys within a module", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [
            { key: "x", type: "text", label: "X" },
            { key: "x", type: "text", label: "X again" },
          ],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toMatch(/duplicate field key/);
  });

  it("flags select fields without options[]", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [{ key: "k", type: "select", label: "K" }],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems.some((p) => /requires a non-empty options/.test(p.problem))).toBe(true);
  });

  it("flags async-select without optionsSource", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [{ key: "k", type: "async-select", label: "K" }],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems.some((p) => /requires optionsSource/.test(p.problem))).toBe(true);
  });

  it("flags async-select whose optionsSource isn't declared in dynamicOptionsLoaders", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [
            {
              key: "k",
              type: "async-select",
              label: "K",
              optionsSource: "nope",
            },
          ],
        },
      ],
      dynamicOptionsLoaders: { other: "handler" },
    });
    const problems = validateManifestFields(m);
    expect(
      problems.some((p) => /not declared in dynamicOptionsLoaders/.test(p.problem)),
    ).toBe(true);
  });

  it("accepts async-select when its optionsSource is declared", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [
            {
              key: "k",
              type: "async-select",
              label: "K",
              optionsSource: "listK",
            },
          ],
        },
      ],
      dynamicOptionsLoaders: { listK: "appsRouter.x.listK" },
    });
    expect(validateManifestFields(m)).toEqual([]);
  });

  it("flags field-mapping missing headersSource", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [{ key: "map", type: "field-mapping", label: "Map" }],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems.some((p) => /requires headersSource/.test(p.problem))).toBe(true);
  });

  it("flags connection-picker missing connectionType", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [{ key: "c", type: "connection-picker", label: "C" }],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems.some((p) => /requires connectionType/.test(p.problem))).toBe(true);
  });

  it("flags dependsOn references to unknown fields", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [
            {
              key: "k",
              type: "text",
              label: "K",
              dependsOn: ["ghost"],
            },
          ],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems.some((p) => /unknown field 'ghost'/.test(p.problem))).toBe(true);
  });

  it("allows dependsOn to reference a field declared later in the same module", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [
            { key: "child", type: "text", label: "Child", dependsOn: ["parent"] },
            { key: "parent", type: "text", label: "Parent" },
          ],
        },
      ],
    });
    expect(validateManifestFields(m)).toEqual([]);
  });

  it("flags dependsOn referencing the field itself", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [{ key: "k", type: "text", label: "K", dependsOn: ["k"] }],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems.some((p) => /cannot reference the field itself/.test(p.problem))).toBe(true);
  });

  it("flags showWhen with zero conditions set", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [
            { key: "a", type: "text", label: "A" },
            { key: "b", type: "text", label: "B", showWhen: { field: "a" } },
          ],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(
      problems.some((p) => /must set exactly one of equals/.test(p.problem)),
    ).toBe(true);
  });

  it("flags showWhen with multiple conditions set", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [
            { key: "a", type: "text", label: "A" },
            {
              key: "b",
              type: "text",
              label: "B",
              showWhen: { field: "a", equals: "x", notEquals: "y" },
            },
          ],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems.some((p) => /more than one of equals/.test(p.problem))).toBe(true);
  });

  it("flags invalid regex in validation.pattern", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [{ key: "k", type: "text", label: "K", validation: { pattern: "[" } }],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems.some((p) => /not a valid regex/.test(p.problem))).toBe(true);
  });

  it("flags validation.minLength > maxLength", () => {
    const m = makeManifest({
      modules: [
        {
          key: "m1",
          name: "M1",
          kind: "action",
          fields: [
            {
              key: "k",
              type: "text",
              label: "K",
              validation: { minLength: 10, maxLength: 5 },
            },
          ],
        },
      ],
    });
    const problems = validateManifestFields(m);
    expect(problems.some((p) => /minLength > maxLength/.test(p.problem))).toBe(true);
  });
});
