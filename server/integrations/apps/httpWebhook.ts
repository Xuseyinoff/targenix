import type { AppManifest } from "../manifest";

/**
 * "Custom HTTP webhook" — simplest destination. User supplies a URL and
 * optional headers; lead is POSTed as JSON. Maps to plainUrlAdapter.
 */
export const httpWebhookApp: AppManifest = {
  key: "plain-url",
  name: "Custom HTTP webhook",
  version: "1.0.0",
  icon: "Globe",
  category: "webhook",
  description: "POST each lead to any custom URL with optional headers.",
  adapterKey: "plain-url",
  connectionType: "none",
  modules: [{ key: "post_lead", name: "POST lead", kind: "action" }],
  availability: "stable",
};
