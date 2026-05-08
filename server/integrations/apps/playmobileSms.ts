import { defineHttpApiKeyApp, defineField } from "../sdk";

export const playmobileSmsApp = defineHttpApiKeyApp({
  key: "playmobile-sms",
  name: "PlayMobile SMS",
  icon: "Smartphone",
  category: "messaging",
  description: "Send SMS messages via PlayMobile — the Uzbekistan government-certified SMS gateway.",
  endpoint: {
    url: "https://api.playmobile.uz/sms/send",
    method: "POST",
    contentType: "application/json",
    authScheme: "bearer",
  },
  extraFields: [
    defineField({
      key: "recipient",
      type: "text",
      label: "Phone number",
      description: "Recipient phone number in international format. Use {{phone_number}}.",
      required: true,
      defaultValue: "{{phone_number}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "text",
      type: "textarea",
      label: "Message text",
      description: "SMS content. Available: {{full_name}}, {{phone_number}}, {{email}}.",
      required: true,
      defaultValue: "Yangi lid: {{full_name}} — {{phone_number}}",
      showTransformPreview: true,
      validation: { maxLength: 160 },
    }),
    defineField({
      key: "originator",
      type: "text",
      label: "Sender (originator)",
      description: "Registered sender name or number.",
      required: false,
    }),
  ],
});
