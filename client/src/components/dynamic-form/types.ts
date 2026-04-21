/**
 * Frontend-facing types for the Dynamic Form engine (Commit 3a of Phase 4).
 *
 * The canonical shapes live on the backend (`server/integrations/manifest.ts`)
 * so the schema is authored alongside the adapter and shared over tRPC. This
 * module re-exports a curated surface: anything the field components in
 * `./fields/*` need to render, plus local helper types that are purely
 * client-side (e.g. validation errors, form state shape).
 *
 * We deliberately re-export the full backend types rather than duplicating
 * them — field components should keep perfect parity with the manifest
 * declared in apps/<key>.ts and errors caught at tsc time beat runtime
 * divergence.
 */

export type {
  AppManifest,
  AppModule,
  ConfigField,
  ConfigFieldOption,
  ConfigFieldShowWhen,
  ConfigFieldType,
  ConfigFieldValidation,
  ConnectionPickerType,
} from "../../../../server/integrations/manifest";

/**
 * One option row returned by the server-side loadOptions loader. Mirrors
 * server/integrations/loaders/types.ts but redeclared here to keep the
 * client bundle independent of the loader internals (the two must match —
 * a TS check guards against drift via a round-trip test in Commit 3b).
 */
export interface LoadedOption {
  value: string;
  label: string;
  meta?: Record<string, unknown>;
}

/**
 * Validation outcome for a single field. Field components receive this from
 * the outer form renderer and surface it under the input.
 */
export type FieldError = string | null | undefined;

/**
 * Common props shared by every field component. Each concrete component
 * extends this with its own value shape (string, number, boolean, mapping
 * object, …). Kept deliberately small: fields render data, the outer form
 * owns state and side effects.
 */
export interface BaseFieldProps {
  /** Field metadata from the manifest. */
  field: import("../../../../server/integrations/manifest").ConfigField;
  /** Disable all interaction — used while parent form is saving. */
  disabled?: boolean;
  /** Validation error to render under the input (when truthy). */
  error?: FieldError;
  /** Hide the label — for inline uses inside larger widgets. */
  hideLabel?: boolean;
  /** Extra className merged onto the outer shell. */
  className?: string;
}
