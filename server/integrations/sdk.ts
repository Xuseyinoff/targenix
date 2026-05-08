/**
 * App SDK — Phase 9 of the Make.com-style refactor.
 *
 * Type-safe builders that produce AppManifest / ConfigField objects with
 * minimal boilerplate. Most useful for http-api-key apps where the only
 * moving parts are the endpoint URL and the user-visible fields.
 *
 * Usage:
 *   import { defineHttpApiKeyApp, defineField } from "../sdk";
 *
 *   export const myApp = defineHttpApiKeyApp({
 *     key: "my-sms",
 *     name: "My SMS",
 *     description: "Send SMS via My SMS provider",
 *     endpoint: { url: "https://api.mysms.com/send", authScheme: "bearer" },
 *     extraFields: [
 *       defineField({ key: "phone",   type: "text",     label: "Phone number", required: true }),
 *       defineField({ key: "message", type: "textarea", label: "Message",      required: true }),
 *     ],
 *   });
 */

import type { AppManifest, AppExecutionEndpoint, AppCategory, ConfigField } from "./manifest";

// ─── Primitive builders ───────────────────────────────────────────────────────

/** Identity wrapper — provides type inference + IDE autocomplete for a field. */
export function defineField(field: ConfigField): ConfigField {
  return field;
}

/** Identity wrapper — provides type inference for a full manifest. */
export function defineApp(manifest: AppManifest): AppManifest {
  return manifest;
}

// ─── HTTP API-key app factory ─────────────────────────────────────────────────

export interface HttpApiKeyAppOptions {
  key: string;
  name: string;
  version?: string;
  icon?: string;
  category?: AppCategory;
  description: string;
  /** Endpoint the adapter will call on delivery. */
  endpoint: AppExecutionEndpoint;
  /**
   * Fields shown in the destination config form (after the built-in
   * connectionId picker). Do NOT include a "connectionId" field here —
   * it is injected automatically as the first field.
   */
  extraFields?: ConfigField[];
}

/**
 * Build an AppManifest for a simple HTTP API-key integration.
 * The resulting manifest points at the "http-api-key" adapter which handles
 * connection loading, decryption, template expansion, and the HTTP call.
 */
export function defineHttpApiKeyApp(opts: HttpApiKeyAppOptions): AppManifest {
  return defineApp({
    key: opts.key,
    name: opts.name,
    version: opts.version ?? "1.0.0",
    icon: opts.icon ?? "Globe",
    category: opts.category ?? "other",
    description: opts.description,
    adapterKey: "http-api-key",
    connectionType: "custom_http",
    executionEndpoint: {
      method: "POST",
      contentType: "application/json",
      authScheme: "bearer",
      ...opts.endpoint,
    },
    modules: [
      {
        key: "send_data",
        name: "Send data",
        kind: "action",
        fields: [
          defineField({
            key: "connectionId",
            type: "connection-picker",
            label: "API connection",
            description: "Pick an api_key connection that holds the credentials for this service.",
            required: true,
            connectionType: "api_key",
          }),
          ...(opts.extraFields ?? []),
        ],
      },
    ],
    availability: "beta",
  });
}
