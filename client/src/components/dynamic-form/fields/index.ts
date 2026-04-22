/**
 * Dynamic-form field components (Commit 3a of Phase 4).
 *
 * Every `ConfigFieldType` from the AppManifest has exactly one renderer in
 * this folder. The DynamicForm root component (Commit 3b) picks the right
 * renderer via `FIELD_COMPONENTS_BY_TYPE` and owns dependency tracking,
 * visibility rules (`showWhen`), and validation.
 *
 * Individual fields stay intentionally dumb: controlled props only, no
 * knowledge of neighbouring fields. This keeps them easy to test in
 * isolation (see DevFormPreview page) and easy to swap/extend.
 */

export { FieldShell } from "./FieldShell";
export { TextField } from "./TextField";
export { PasswordField } from "./PasswordField";
export { TextareaField } from "./TextareaField";
export { NumberField } from "./NumberField";
export { BooleanField } from "./BooleanField";
export { SelectField } from "./SelectField";
export { MultiSelectField } from "./MultiSelectField";
export { AsyncSelectField } from "./AsyncSelectField";
export { ConnectionPickerField } from "./ConnectionPickerField";
export { FieldMappingField } from "./FieldMappingField";
export { CodeField } from "./CodeField";
export { HiddenField } from "./HiddenField";
export { RepeatableField } from "./RepeatableField";
export { GroupField } from "./GroupField";
export { MapToggleWrapper } from "./MapToggleWrapper";

export type { TextFieldProps } from "./TextField";
export type { PasswordFieldProps } from "./PasswordField";
export type { TextareaFieldProps } from "./TextareaField";
export type { NumberFieldProps } from "./NumberField";
export type { BooleanFieldProps } from "./BooleanField";
export type { SelectFieldProps } from "./SelectField";
export type { MultiSelectFieldProps } from "./MultiSelectField";
export type { AsyncSelectFieldProps } from "./AsyncSelectField";
export type { ConnectionPickerFieldProps } from "./ConnectionPickerField";
export type { FieldMappingFieldProps, FieldMapping } from "./FieldMappingField";
export type { CodeFieldProps } from "./CodeField";
export type { HiddenFieldProps } from "./HiddenField";
export type { RepeatableFieldProps, RepeatableRowValues } from "./RepeatableField";
export type { GroupFieldProps } from "./GroupField";
export type { MapToggleWrapperProps, AvailableVariable } from "./MapToggleWrapper";

import type { ConfigFieldType } from "../types";

/**
 * Map of field types → renderer component names. Used by the DynamicForm
 * root (Commit 3b) to dispatch. Kept as a const map (not a React map) so the
 * table is type-checked against `ConfigFieldType` at compile time.
 */
export const FIELD_TYPES_WITH_COMPONENTS: ReadonlyArray<ConfigFieldType> = [
  "text",
  "password",
  "textarea",
  "number",
  "boolean",
  "select",
  "multi-select",
  "async-select",
  "connection-picker",
  "field-mapping",
  "code",
  "hidden",
  "repeatable",
  "group",
] as const;
