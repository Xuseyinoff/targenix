import type { AppManifest } from "../manifest";

export const hubspotApp: AppManifest = {
  key: "hubspot",
  name: "HubSpot",
  version: "1.0.0",
  // Brand logo (Make.com-style): white glyph on colored tile in UI.
  icon: "https://logo.clearbit.com/hubspot.com",
  category: "crm",
  description: "Create contacts in HubSpot CRM via OAuth2. Connect once, sync leads automatically.",
  adapterKey: "http-oauth2",
  connectionType: "oauth2",
  modules: [
    {
      key: "create_contact",
      name: "Create contact",
      kind: "action",
      description: "Create a new contact in HubSpot from a Facebook lead.",
      fields: [
        {
          key: "connectionId",
          type: "connection-picker",
          label: "HubSpot account",
          description: "Connect your HubSpot account via OAuth.",
          required: true,
          connectionType: "hubspot",
        },
        {
          key: "firstname",
          type: "text",
          label: "First name",
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
          key: "company",
          type: "text",
          label: "Company",
          required: false,
          showTransformPreview: true,
          mappable: true,
        },
      ],
    },
  ],
  executionEndpoint: {
    url: "https://api.hubapi.com/crm/v3/objects/contacts",
    method: "POST",
    contentType: "application/json",
    authScheme: "bearer",
  },
  availability: "stable",
};
