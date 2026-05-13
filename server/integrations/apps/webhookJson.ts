import { defineHttpApiKeyApp, defineField } from "../sdk";

export const webhookJsonApp = defineHttpApiKeyApp({
  key: "webhook-json",
  name: "Webhook / JSON",
  icon: "Webhook",
  category: "other",
  description: "POST lead data as JSON to any webhook URL — no API key required.",
  noConnection: true,
  // Phase 3 of the http-refactor — superseded by `http-request`. Hidden from
  // the catalogue immediately; the adapter is retired in Phase 4 after a
  // verification window confirms no legacy rows reference this appKey.
  availability: "deprecated",
  endpoint: {
    url: "{{endpointUrl}}",
    method: "POST",
    contentType: "application/json",
    authScheme: "none",
  },
  extraFields: [
    defineField({
      key: "endpointUrl",
      type: "text",
      label: "Webhook URL",
      description: "The URL that will receive a POST request with lead data as JSON.",
      required: true,
      placeholder: "https://your-service.com/webhook",
      validation: { pattern: "^https?://" },
    }),
    defineField({
      key: "name",
      type: "text",
      label: "name",
      description: "Lead name sent in the JSON body.",
      required: false,
      defaultValue: "{{full_name}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "phone",
      type: "text",
      label: "phone",
      required: false,
      defaultValue: "{{phone_number}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "email",
      type: "text",
      label: "email",
      required: false,
      defaultValue: "{{email}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "source",
      type: "text",
      label: "source",
      description: "Custom source tag sent with every lead.",
      required: false,
      defaultValue: "targenix",
    }),
  ],
});
