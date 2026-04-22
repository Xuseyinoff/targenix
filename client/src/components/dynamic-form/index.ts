/**
 * Public barrel for the Dynamic Form engine (Phase 4 — Commits 3a + 3b).
 *
 * Anything a consumer page needs:
 *   - The <DynamicForm> root renderer
 *   - Pure validation/visibility helpers (validateFields, isFieldVisible…)
 *   - The seed helper for initial form state
 *   - Shared types (re-exported from ./types)
 *
 * Field components are NOT re-exported from here on purpose: consumers
 * should always go through <DynamicForm> so showWhen, cascades, and
 * connection plumbing stay consistent. If you find yourself wanting a bare
 * field in application code, reach into `./fields` directly — that's a
 * signal to reconsider, not a forbidden move.
 */

export { DynamicForm, seedInitialValues } from "./DynamicForm";
export type { DynamicFormProps } from "./DynamicForm";

export {
  validateField,
  validateFields,
  isFieldVisible,
  isEmptyValue,
  evaluateShowWhen,
  initialValueForField,
  collectDependentKeys,
} from "./validation";
export type { FieldValues, ValidationResult } from "./validation";

export type {
  AppManifest,
  AppModule,
  ConfigField,
  ConfigFieldOption,
  ConfigFieldShowWhen,
  ConfigFieldType,
  ConfigFieldValidation,
  ConnectionPickerType,
  BaseFieldProps,
  FieldError,
  LoadedOption,
} from "./types";

// Public variable-catalogue types for the per-field Map toggle. Callers
// (e.g. DestinationCreatorInline, IntegrationWizardV2) import these when
// they build a grouped "Lead metadata" + "Field data" picker tree.
export type {
  AvailableVariable,
  VariableGroup,
  VariableCatalogue,
} from "./fields";
