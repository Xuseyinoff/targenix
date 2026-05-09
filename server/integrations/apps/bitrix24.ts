import { defineHttpApiKeyApp, defineField } from "../sdk";

/**
 * Bitrix24 CRM — creates a lead via the REST webhook URL.
 *
 * Auth is embedded in the webhook URL (format:
 *   https://DOMAIN.bitrix24.uz/rest/USER_ID/WEBHOOK_TOKEN/crm.lead.add.json
 * ) so no separate API key connection is needed.
 */
export const bitrix24App = defineHttpApiKeyApp({
  key: "bitrix24",
  name: "Bitrix24",
  icon: "/api/brand-icons/bitrix24.svg",
  category: "crm",
  description: "Create CRM leads in Bitrix24 via REST webhook. Popular in Uzbekistan and CIS.",
  noConnection: true,
  endpoint: {
    url: "{{webhookUrl}}",
    method: "POST",
    contentType: "application/json",
    authScheme: "none",
  },
  extraFields: [
    defineField({
      key: "webhookUrl",
      type: "text",
      label: "Webhook URL",
      description:
        "Full REST webhook URL from Bitrix24 settings. Format: https://DOMAIN.bitrix24.uz/rest/USER_ID/TOKEN/crm.lead.add.json",
      required: true,
      placeholder: "https://yourcompany.bitrix24.uz/rest/1/abc123xyz/crm.lead.add.json",
      validation: { pattern: "^https?://" },
    }),
    defineField({
      key: "TITLE",
      type: "text",
      label: "Lead title",
      required: false,
      defaultValue: "Lead from {{pageName}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "NAME",
      type: "text",
      label: "Contact name",
      required: false,
      defaultValue: "{{full_name}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "PHONE",
      type: "text",
      label: "Phone",
      required: false,
      defaultValue: "{{phone_number}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "EMAIL",
      type: "text",
      label: "Email",
      required: false,
      defaultValue: "{{email}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "SOURCE_ID",
      type: "select",
      label: "Lead source",
      required: false,
      options: [
        { label: "Facebook Ads", value: "ADVERTISING" },
        { label: "Web form", value: "WEB" },
        { label: "Call", value: "CALL" },
        { label: "Other", value: "OTHER" },
      ],
      defaultValue: "ADVERTISING",
    }),
  ],
});
