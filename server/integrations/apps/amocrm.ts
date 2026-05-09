import { defineHttpApiKeyApp, defineField } from "../sdk";

/**
 * AmoCRM / Kommo CRM — creates a lead via the REST API v4.
 *
 * Requires a long-lived access token (generate from AmoCRM Integrations >
 * Private integrations > Access token).
 * API docs: https://www.kommo.com/developers/content/crm-platform/leads-api/
 */
export const amocrmApp = defineHttpApiKeyApp({
  key: "amocrm",
  name: "AmoCRM / Kommo",
  icon: "https://logo.clearbit.com/amocrm.com",
  category: "crm",
  description: "Create leads in AmoCRM (Kommo) via API v4 using a Bearer access token.",
  endpoint: {
    url: "https://{{subdomain}}.kommo.com/api/v4/leads",
    method: "POST",
    contentType: "application/json",
    authScheme: "bearer",
  },
  extraFields: [
    defineField({
      key: "subdomain",
      type: "text",
      label: "Account subdomain",
      description: "Your Kommo/AmoCRM subdomain (e.g. if your URL is mycompany.kommo.com, enter mycompany).",
      required: true,
      placeholder: "mycompany",
    }),
    defineField({
      key: "name",
      type: "text",
      label: "Lead name",
      required: false,
      defaultValue: "{{full_name}} — {{pageName}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "pipeline_id",
      type: "number",
      label: "Pipeline ID",
      description: "Optional. ID of the sales pipeline. Leave empty for default pipeline.",
      required: false,
    }),
    defineField({
      key: "status_id",
      type: "number",
      label: "Status ID",
      description: "Optional. ID of the initial stage in the pipeline.",
      required: false,
    }),
  ],
});
