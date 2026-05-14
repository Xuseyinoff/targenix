/**
 * IntegrationWizardV2 — shared state types.
 *
 * Extracted from IntegrationWizardV2.tsx so the wizard's sub-components
 * (TriggerEditor, DestinationEditor, AppManifestMapper, …) can import the
 * state shape without pulling in the 2000-line page module.
 */

import type { FieldMapping } from "./shared";

/**
 * One entry in the ordered destination list.
 *
 * `leadFields` — per-destination FROM_LEAD mapping (via resolveDestManifest).
 *   key   = manifest field key ("name", "phone", or custom for custom type)
 *   value = FB form field key that feeds this payload key ("full_name", etc.)
 * For `custom` template type, `leadFields` is empty and `customMappings` is
 * used instead (the FieldMappingsEditor rows).
 */
export interface DestinationEntry {
  id: number;
  name: string;
  templateType: string;
  /** Manifest-driven FROM_LEAD mappings: { name: "full_name", phone: "phone_number" } */
  leadFields: Record<string, string>;
  /**
   * Per-key static overrides for manifest fields with `mode: "static"`.
   * Seeded from the destination's `templateConfig[key]` admin default and
   * persisted to `integration.config.variableFields` on save so
   * `sendLeadViaTemplate` picks them up via `{{key}}` substitution in
   * bodyFields. Secrets (mode="secret") NEVER live here — they come from
   * the destination's stored credential and are read-only in the wizard.
   */
  staticValues: Record<string, string>;
  /** Custom/extra mappings for destinations without a fixed manifest (type="custom"). */
  customMappings: FieldMapping[];
}

export interface WizardState {
  // Trigger
  accountId: number | null;
  accountName: string;
  pageId: string;
  pageName: string;
  formId: string;
  formName: string;
  // Destinations — ordered list (Commit 6c). The first entry is the
  // "primary" destination: it drives field mapping + variable resolution
  // and is written to `integrations.destinationId` for legacy compat.
  // Additional entries fan-out via `integration_routes`.
  destinations: DestinationEntry[];
  // Meta
  integrationName: string;
  /**
   * True once the user has manually edited the integration name. Until then
   * the auto-fill effect keeps it in sync with "page → destinations" so that
   * changing the destination list updates the preview automatically.
   */
  integrationNameTouched: boolean;
}

export const INITIAL_STATE: WizardState = {
  accountId: null,
  accountName: "",
  pageId: "",
  pageName: "",
  formId: "",
  formName: "",
  destinations: [],
  integrationName: "",
  integrationNameTouched: false,
};
