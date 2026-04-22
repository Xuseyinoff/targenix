import type { AppManifest } from "../manifest";

/**
 * "Custom HTTP webhook" — simplest user-defined destination.
 *
 * The user supplies a target URL + optional headers/query/body + a request
 * body. On every new lead the plainUrlAdapter (or affiliateService for
 * template-configured sites) POSTs/GETs to that URL with the rendered body.
 * No OAuth or stored credentials needed — everything lives in
 * templateConfig.
 *
 * Feature surface mirrors Make.com's HTTP → "Make a request" module:
 *
 *   ┌ URL ─────────────────────────────────────────┐
 *   │ Method ─────────────────────────────────────┐ │
 *   │ Body group (POST only) ─────────────────────┐ │ │
 *   │   Content type select ─────────────────────┐ │ │ │
 *   │   Body JSON (when json)                    │ │ │ │
 *   │   Body fields (when form-urlencoded/mpart) │ │ │ │
 *   ├ Advanced settings (collapsible) ──────────────┤
 *   │   Headers (row builder)                       │
 *   │   Query string (row builder)                  │
 *   └───────────────────────────────────────────────┘
 *
 * Every scalar that accepts trigger data (URL, body values, header values,
 * query values) is `mappable: true` so the Map toggle offers a variable
 * picker — DestinationCreatorInline seeds the variable list with the lead
 * payload keys that injectVariables already expands at delivery time.
 *
 * What this schema does NOT do (yet):
 *   - Multi-condition showWhen (e.g. method=POST AND contentType=json). We
 *     work around it by wrapping the body options in a group whose showWhen
 *     hides the entire section for GET requests — cleaner UX than a flat
 *     OR-chained list.
 *   - Basic auth / OAuth — the connections table covers this when we need
 *     it; the raw webhook is intentionally credential-free.
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
  version: "1.2.0",
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
          mappable: true,
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

        // ── Body group (POST only) ────────────────────────────────────────
        // Wrapped in a group so GET requests never show the body controls —
        // and so content-type + JSON template + field rows visually live in
        // one "Request body" card instead of floating at the top level.
        {
          key: "bodyGroup",
          type: "group",
          label: "Request body",
          description: "How the request body is encoded and what it contains.",
          showWhen: { field: "method", equals: "POST" },
          groupFields: [
            {
              key: "contentType",
              type: "select",
              label: "Content type",
              description:
                "JSON for most modern APIs. Form-urlencoded / multipart for legacy endpoints and file uploads.",
              required: false,
              defaultValue: "json",
              options: [...CONTENT_TYPE_OPTIONS],
            },
            {
              key: "bodyTemplate",
              type: "code",
              label: "Request content (JSON)",
              description:
                "Sent as the request body. Use {{full_name}}, {{phone_number}}, {{email}}, {{pageName}}, {{formName}} and any other lead variable.",
              required: false,
              defaultValue: DEFAULT_JSON_BODY,
              validation: { maxLength: 8192 },
              showWhen: { field: "contentType", equals: "json" },
            },
            // Make.com-style row builder for form-urlencoded / multipart bodies.
            // `bodyFields` is the exact shape affiliateService.buildCustomBody
            // already consumes at delivery time (Array<{ key, value }>), so
            // no server change is needed — the dynamic form matches the
            // existing contract byte-for-byte.
            {
              key: "bodyFields",
              type: "repeatable",
              label: "Request fields",
              description:
                "One row per form field. Values support {{lead_variable}} placeholders.",
              required: false,
              addButtonLabel: "Add field",
              maxItems: 50,
              showWhen: { field: "contentType", in: ["form-urlencoded", "multipart"] },
              itemFields: [
                {
                  key: "key",
                  type: "text",
                  label: "Name",
                  required: true,
                  placeholder: "full_name",
                  validation: { maxLength: 128 },
                },
                {
                  key: "value",
                  type: "text",
                  label: "Value",
                  required: false,
                  placeholder: "{{full_name}}",
                  mappable: true,
                  validation: { maxLength: 2048 },
                },
              ],
            },
          ],
        },

        // ── Advanced settings (collapsible) ────────────────────────────────
        // Headers + query string. Both are row builders — the legacy JSON
        // blob textarea is gone because nobody should have to hand-craft
        // JSON just to set a Bearer token.
        {
          key: "advanced",
          type: "group",
          label: "Advanced settings",
          description: "Optional HTTP headers, query string, and extra request controls.",
          required: false,
          collapsible: true,
          defaultCollapsed: true,
          groupFields: [
            {
              key: "headers",
              type: "repeatable",
              label: "Headers",
              description:
                "Custom HTTP headers sent with every request. Values support {{variable}} placeholders.",
              required: false,
              addButtonLabel: "Add header",
              maxItems: 32,
              itemFields: [
                {
                  key: "name",
                  type: "text",
                  label: "Name",
                  required: true,
                  placeholder: "Authorization",
                  validation: { maxLength: 256 },
                },
                {
                  key: "value",
                  type: "text",
                  label: "Value",
                  required: true,
                  placeholder: "Bearer …",
                  sensitive: true,
                  mappable: true,
                  validation: { maxLength: 2048 },
                },
              ],
            },
            // Query parameters get appended to the URL by buildCreatePayload
            // on save — server schema stays unchanged, so this field can
            // ship without any delivery-path risk.
            {
              key: "queryParams",
              type: "repeatable",
              label: "Query string",
              description:
                "Appended to the URL as ?name=value. Values support {{lead_variable}} placeholders.",
              required: false,
              addButtonLabel: "Add parameter",
              maxItems: 32,
              itemFields: [
                {
                  key: "name",
                  type: "text",
                  label: "Parameter",
                  required: true,
                  placeholder: "utm_source",
                  validation: { maxLength: 128 },
                },
                {
                  key: "value",
                  type: "text",
                  label: "Value",
                  required: true,
                  placeholder: "facebook",
                  mappable: true,
                  validation: { maxLength: 512 },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  availability: "stable",
};
