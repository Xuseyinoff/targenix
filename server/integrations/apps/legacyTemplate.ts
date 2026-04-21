import type { AppManifest } from "../manifest";

/**
 * Hardcoded legacy templates (sotuvchi, 100k, custom). Kept for backward
 * compatibility with existing target_websites rows. New destinations should
 * use "dynamic-template" (admin-managed) instead.
 */
export const legacyTemplateApp: AppManifest = {
  key: "legacy-template",
  name: "Legacy template",
  version: "1.0.0",
  icon: "Archive",
  category: "ecommerce",
  description:
    "Hardcoded legacy destination templates. Kept for backward compatibility.",
  adapterKey: "legacy-template",
  connectionType: "none",
  modules: [{ key: "send_lead", name: "Send lead", kind: "action" }],
  availability: "deprecated",
  internal: true,
};
