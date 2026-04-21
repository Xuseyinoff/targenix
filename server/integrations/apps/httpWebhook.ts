import type { AppManifest } from "../manifest";

/**
 * "Custom HTTP webhook" — simplest user-defined destination.
 *
 * The user supplies a target URL + optional headers + a request body. On every
 * new lead the plainUrlAdapter POSTs (or GETs) to that URL with the rendered
 * body. No OAuth or stored credentials needed — everything lives in
 * templateConfig.
 *
 * The ConfigField schema below is what powers the dynamic form in the v2
 * integration wizard (Phase 4 — Commit 5c). It mirrors the legacy
 * "custom" branch of targetWebsites.create so we can create webhooks through
 * the new wizard without changing the server contract.
 *
 * We intentionally do NOT expose the full "variable fields" builder here yet:
 *   - bodyTemplate already supports {{placeholder}} expansion via
 *     affiliateService.injectVariables at delivery time, which covers every
 *     practical lead-to-webhook case.
 *   - The advanced bodyFields / jsonField pairing is a niche legacy feature
 *     (DestinationCreate.tsx has a full UI for it). When we migrate the
 *     legacy page to the dynamic form engine in Commit 6 we'll add a
 *     purpose-built field type for it instead of stretching textarea.
 */

const CONTENT_TYPE_OPTIONS = [
  { value: "json", label: "JSON (application/json)" },
  { value: "form-urlencoded", label: "Form URL-encoded" },
  { value: "multipart", label: "Multipart form-data" },
] as const;

const METHOD_OPTIONS = [
  { value: "POST", label: "POST" },
  { value: "GET", label: "GET" },
] as const;

const DEFAULT_JSON_BODY = `{
  "full_name": "{{full_name}}",
  "phone_number": "{{phone_number}}",
  "email": "{{email}}"
}`;

export const httpWebhookApp: AppManifest = {
  key: "plain-url",
  name: "Custom HTTP webhook",
  version: "1.1.0",
  icon: "Globe",
  category: "webhook",
  description: "POST each lead to any custom URL with optional headers.",
  adapterKey: "plain-url",
  connectionType: "none",
  modules: [
    {
      key: "post_lead",
      name: "POST lead",
      kind: "action",
      description:
        "Send each lead as an HTTP request to a URL of your choice. Works with Zapier catch-hooks, n8n webhook nodes, or any custom endpoint.",
      fields: [
        {
          key: "url",
          type: "text",
          label: "URL",
          description: "The endpoint that will receive the lead payload.",
          required: true,
          placeholder: "https://example.com/api/leads",
          validation: { maxLength: 2048 },
        },
        {
          key: "method",
          type: "select",
          label: "HTTP method",
          required: false,
          defaultValue: "POST",
          options: [...METHOD_OPTIONS],
        },
        {
          key: "contentType",
          type: "select",
          label: "Content type",
          description: "How the request body is encoded. JSON is the usual choice.",
          required: false,
          defaultValue: "json",
          options: [...CONTENT_TYPE_OPTIONS],
          showWhen: { field: "method", equals: "POST" },
        },
        {
          key: "bodyTemplate",
          type: "code",
          label: "Body template",
          description:
            "Request body sent with every lead. Use {{full_name}}, {{phone_number}}, {{email}}, {{pageName}}, {{formName}} and any other lead variable.",
          required: false,
          defaultValue: DEFAULT_JSON_BODY,
          validation: { maxLength: 8192 },
          showWhen: { field: "method", equals: "POST" },
        },
        {
          key: "headers",
          type: "code",
          label: "Headers (JSON)",
          description:
            'Optional HTTP headers as a JSON object. Example: { "Authorization": "Bearer …" }',
          required: false,
          placeholder: "{}",
          validation: { maxLength: 4096 },
        },
      ],
    },
  ],
  availability: "stable",
};
