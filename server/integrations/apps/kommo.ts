import type { AppManifest } from "../manifest";

/**
 * Kommo (AmoCRM) — OAuth2 version.
 * Creates a lead with embedded contact via the Kommo REST API v4.
 * The `subdomain` field in templateConfig is injected into the URL at delivery.
 */
export const kommoApp: AppManifest = {
  key: "kommo",
  name: "Kommo (AmoCRM) OAuth",
  version: "1.0.0",
  icon: "/api/brand-icons/kommo.svg?color=fff",
  category: "crm",
  description: "Create leads in Kommo CRM via OAuth2. Connect once, send leads automatically.",
  adapterKey: "http-oauth2",
  connectionType: "oauth2",
  modules: [
    {
      key: "create_lead",
      name: "Create lead",
      kind: "action",
      description: "Create a new lead with contact in Kommo (AmoCRM).",
      fields: [
        {
          key: "connectionId",
          type: "connection-picker",
          label: "Kommo account",
          description: "Connect your Kommo account via OAuth.",
          required: true,
          connectionType: "kommo",
        },
        {
          key: "subdomain",
          type: "text",
          label: "Account subdomain",
          description:
            "Your Kommo subdomain (e.g. if your URL is mycompany.kommo.com, enter mycompany).",
          required: true,
          placeholder: "mycompany",
        },
        {
          key: "lead_name",
          type: "text",
          label: "Lead name",
          required: false,
          defaultValue: "{{full_name}} — {{pageName}}",
          showTransformPreview: true,
          mappable: true,
        },
        {
          key: "name",
          type: "text",
          label: "Contact name",
          required: false,
          defaultValue: "{{full_name}}",
          showTransformPreview: true,
          mappable: true,
        },
        {
          key: "phone",
          type: "text",
          label: "Phone",
          required: false,
          defaultValue: "{{phone}}",
          showTransformPreview: true,
          mappable: true,
        },
        {
          key: "email",
          type: "text",
          label: "Email",
          required: false,
          defaultValue: "{{email}}",
          showTransformPreview: true,
          mappable: true,
        },
        {
          key: "pipeline_id",
          type: "number",
          label: "Pipeline ID",
          description: "Optional pipeline ID. Leave empty for default.",
          required: false,
        },
        {
          key: "status_id",
          type: "number",
          label: "Status ID",
          description: "Optional initial stage ID.",
          required: false,
        },
      ],
    },
  ],
  executionEndpoint: {
    url: "https://{{subdomain}}.kommo.com/api/v4/leads",
    method: "POST",
    contentType: "application/json",
    authScheme: "bearer",
  },
  availability: "stable",
};
