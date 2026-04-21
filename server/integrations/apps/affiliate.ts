import type { AppManifest } from "../manifest";

/**
 * Legacy affiliate integration. The standalone AFFILIATE integration type was
 * removed from the product UI (see integrationsRouter.create) — only legacy
 * AFFILIATE rows in the database still hit this adapter. Hidden from pickers.
 */
export const affiliateApp: AppManifest = {
  key: "affiliate",
  name: "Affiliate",
  version: "1.0.0",
  icon: "Zap",
  category: "affiliate",
  description: "Legacy affiliate integration. Not user-creatable.",
  adapterKey: "affiliate",
  connectionType: "none",
  modules: [{ key: "send_order", name: "Send order", kind: "action" }],
  availability: "deprecated",
  internal: true,
};
