import { defineHttpApiKeyApp, defineField } from "../sdk";

export const crmGenericApp = defineHttpApiKeyApp({
  key: "crm-generic",
  name: "Custom CRM / HTTP",
  icon: "Database",
  category: "ecommerce",
  description: "Push leads to any CRM or HTTP endpoint that accepts a JSON payload with Bearer auth.",
  endpoint: {
    // URL is provided by the user via the endpointUrl field below.
    // The adapter will use this placeholder if the field is empty.
    url: "{{endpointUrl}}",
    method: "POST",
    contentType: "application/json",
    authScheme: "bearer",
  },
  extraFields: [
    defineField({
      key: "endpointUrl",
      type: "text",
      label: "Endpoint URL",
      description: "The full URL the adapter will POST to (e.g. https://your-crm.com/api/leads).",
      required: true,
      placeholder: "https://your-crm.com/api/leads",
      validation: { pattern: "^https?://" },
    }),
    defineField({
      key: "name",
      type: "text",
      label: "Name field",
      description: "Lead name value sent in the JSON body.",
      required: false,
      defaultValue: "{{full_name}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "phone",
      type: "text",
      label: "Phone field",
      required: false,
      defaultValue: "{{phone_number}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "email",
      type: "text",
      label: "Email field",
      required: false,
      defaultValue: "{{email}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "extraBody",
      type: "code",
      label: "Extra body fields (JSON)",
      description: 'Optional JSON object merged into the request body. E.g. {"source":"targenix"}.',
      required: false,
      placeholder: '{"source": "targenix"}',
    }),
  ],
});
