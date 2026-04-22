import type { AppManifest } from "../manifest";

/**
 * Admin-managed destination template — meta-adapter for every row in
 * destination_templates. End users never pick this directly; they pick the
 * concrete affiliate (Sotuvchi.com, 100k.uz, Inbaza.uz, MyCPA, …) which is
 * then dispatched to this adapter server-side.
 *
 * Marked `internal: true` so it's filtered out of user-facing app pickers.
 * The admin templates surface is exposed through a separate route —
 * `targetWebsites.getTemplates` — which returns the actual affiliate rows.
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
  internal: true,
};
