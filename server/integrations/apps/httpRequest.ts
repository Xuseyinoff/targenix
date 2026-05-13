import type { AppManifest } from "../manifest";

/**
 * Universal HTTP Request app — consolidates the three existing custom HTTP
 * apps (`webhook-json`, `plain-url`, `crm-generic`) into a single
 * authoring surface that mirrors Make.com's "HTTP → Make a request" and
 * Zapier's "Webhooks by Zapier" modules.
 *
 * Why a separate app at all (not just enhancing `plain-url`)?
 *   - `plain-url` is the most flexible of the three but lacks built-in
 *     authentication — admins paste `Authorization: Bearer …` headers by
 *     hand, with no UI affordance, no encrypted storage, and no protection
 *     against logging the secret. The universal app folds in an explicit
 *     `authentication` group that the adapter turns into the correct
 *     header / query / body parameter automatically.
 *   - `webhook-json` and `crm-generic` rely on `httpApiKeyAdapter`, which
 *     bakes the endpoint URL and method into the manifest. They cannot
 *     express GET requests, multiple content types, query parameters, or
 *     custom headers. Folding them in means users no longer have to choose
 *     between "easy" and "powerful" surfaces — there is just one app, with
 *     presets layered on top in the UI.
 *
 * Migration: the existing three apps remain registered in this commit so
 * destinations created against them keep delivering. The follow-up sprint
 * (see ROADMAP) writes a one-shot script that copies each old destination
 * into a new `http-request` row with the equivalent config (auth=none for
 * webhook-json/plain-url, auth=bearer for crm-generic) and flips the
 * `appKey` over. The old apps are then unregistered and their adapter
 * code paths retired in a separate commit.
 */

const CONTENT_TYPE_OPTIONS = [
  { value: "json", label: "JSON (application/json)" },
  { value: "form-urlencoded", label: "Form URL-encoded" },
  { value: "multipart", label: "Multipart form-data" },
] as const;

const METHOD_OPTIONS = [
  { value: "POST", label: "POST" },
  { value: "GET", label: "GET" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
] as const;

const AUTH_OPTIONS = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token" },
  { value: "api_key_header", label: "API key (header)" },
  { value: "basic", label: "Basic auth" },
] as const;

const DEFAULT_JSON_BODY = `{
  "full_name": "{{full_name}}",
  "phone_number": "{{phone_number}}",
  "email": "{{email}}"
}`;

export const httpRequestApp: AppManifest = {
  key: "http-request",
  name: "HTTP Request",
  version: "1.0.0",
  icon: "Globe",
  category: "webhook",
  description:
    "Universal HTTP request — works as a plain webhook, a CRM endpoint, or a custom API call. Choose any method, content type, and authentication scheme.",
  adapterKey: "http-request",
  connectionType: "none",
  // Optional auth uses inline secret fields (Bearer / API key / Basic), so
  // no shared connection row is required. A future iteration may route
  // Bearer tokens through the `connections` table when a token is reused
  // across multiple destinations — for now the secrets are scoped per row.
  modules: [
    {
      key: "send",
      name: "Send HTTP request",
      kind: "action",
      description:
        "Send each lead as an HTTP request to any URL. Mirrors Make.com's HTTP module and Zapier's Webhooks → POST.",
      fields: [
        // ── URL & method ─────────────────────────────────────────────────
        {
          key: "url",
          type: "text",
          label: "URL",
          description: "The endpoint that will receive the lead payload.",
          required: true,
          placeholder: "https://api.example.com/leads",
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

        // ── Authentication ───────────────────────────────────────────────
        // Single dropdown gates the secret inputs below. The adapter
        // resolves the scheme into the right header/body so admins never
        // have to hand-craft `Authorization: Bearer …`.
        {
          key: "authentication",
          type: "group",
          label: "Authentication",
          description: "How the request authenticates against the target.",
          required: false,
          collapsible: true,
          defaultCollapsed: false,
          groupFields: [
            {
              key: "scheme",
              type: "select",
              label: "Scheme",
              required: false,
              defaultValue: "none",
              options: [...AUTH_OPTIONS],
            },
            // Bearer
            {
              key: "bearerToken",
              type: "text",
              label: "Bearer token",
              description: "Sent as `Authorization: Bearer <token>`.",
              required: false,
              sensitive: true,
              mappable: false,
              showWhen: { field: "scheme", equals: "bearer" },
              validation: { maxLength: 2048 },
            },
            // API key — header variant
            {
              key: "apiKeyHeader",
              type: "text",
              label: "Header name",
              description: "Name of the header the API key is sent in.",
              required: false,
              defaultValue: "X-API-Key",
              showWhen: { field: "scheme", equals: "api_key_header" },
              validation: { maxLength: 128 },
            },
            {
              key: "apiKeyValue",
              type: "text",
              label: "API key value",
              required: false,
              sensitive: true,
              showWhen: { field: "scheme", equals: "api_key_header" },
              validation: { maxLength: 2048 },
            },
            // Basic auth
            {
              key: "basicUsername",
              type: "text",
              label: "Username",
              required: false,
              showWhen: { field: "scheme", equals: "basic" },
              validation: { maxLength: 256 },
            },
            {
              key: "basicPassword",
              type: "text",
              label: "Password",
              required: false,
              sensitive: true,
              showWhen: { field: "scheme", equals: "basic" },
              validation: { maxLength: 1024 },
            },
          ],
        },

        // ── Request body (POST/PUT/PATCH only) ───────────────────────────
        // GET / DELETE intentionally omit the body controls — same UX as
        // Make.com's HTTP module, where the body section disappears for
        // verbs that aren't supposed to carry one.
        {
          key: "bodyGroup",
          type: "group",
          label: "Request body",
          description: "How the request body is encoded and what it contains.",
          showWhen: { field: "method", in: ["POST", "PUT", "PATCH"] },
          groupFields: [
            {
              key: "contentType",
              type: "select",
              label: "Content type",
              description:
                "JSON for most modern APIs. Form-urlencoded / multipart for legacy endpoints.",
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

        // ── Headers + Query params (always available) ────────────────────
        {
          key: "advanced",
          type: "group",
          label: "Advanced settings",
          description: "Optional HTTP headers and query string parameters.",
          required: false,
          collapsible: true,
          defaultCollapsed: true,
          groupFields: [
            {
              key: "headers",
              type: "repeatable",
              label: "Headers",
              description:
                "Custom HTTP headers sent with every request. Values support {{variable}} placeholders. Avoid using this for auth — use the Authentication section above instead.",
              required: false,
              addButtonLabel: "Add header",
              maxItems: 32,
              itemFields: [
                {
                  key: "name",
                  type: "text",
                  label: "Name",
                  required: true,
                  placeholder: "X-Custom-Header",
                  validation: { maxLength: 256 },
                },
                {
                  key: "value",
                  type: "text",
                  label: "Value",
                  required: true,
                  placeholder: "value",
                  mappable: true,
                  validation: { maxLength: 2048 },
                },
              ],
            },
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
  availability: "beta",
};
