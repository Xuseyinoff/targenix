import type { AppManifest } from "../manifest";

/**
 * Admin-managed destination template — defined in destination_templates.
 * Drives ~99.997% of production traffic (100k.uz, sotuvchi.com, …).
 */
export const dynamicTemplateApp: AppManifest = {
  key: "dynamic-template",
  name: "Admin template",
  version: "1.0.0",
  icon: "FileJson",
  category: "ecommerce",
  description:
    "Admin-defined destination template with JSON body, variable fields and headers.",
  adapterKey: "dynamic-template",
  connectionType: "none",
  modules: [{ key: "send_lead", name: "Send lead", kind: "action" }],
  availability: "stable",
};
