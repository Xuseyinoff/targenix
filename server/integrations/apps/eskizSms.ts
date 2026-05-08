import { defineHttpApiKeyApp, defineField } from "../sdk";

export const eskizSmsApp = defineHttpApiKeyApp({
  key: "eskiz-sms",
  name: "Eskiz SMS",
  icon: "MessageSquare",
  category: "messaging",
  description: "Send SMS notifications to leads via Eskiz (Uzbekistan's leading SMS gateway).",
  endpoint: {
    url: "https://notify.eskiz.uz/api/message/sms/send",
    method: "POST",
    contentType: "application/json",
    authScheme: "bearer",
  },
  extraFields: [
    defineField({
      key: "mobile_phone",
      type: "text",
      label: "Phone number",
      description: "Recipient's mobile phone number. Use {{phone_number}} to insert the lead's phone.",
      required: true,
      defaultValue: "{{phone_number}}",
      showTransformPreview: true,
    }),
    defineField({
      key: "message",
      type: "textarea",
      label: "Message",
      description: "SMS text. Available: {{full_name}}, {{phone_number}}, {{email}}, {{pageName}}, {{formName}}.",
      required: true,
      defaultValue: "Yangi lead: {{full_name}}, {{phone_number}}",
      showTransformPreview: true,
      validation: { maxLength: 160 },
    }),
    defineField({
      key: "from",
      type: "text",
      label: "Sender ID",
      description: "Registered alphanumeric sender ID (e.g. 4546). Leave empty to use account default.",
      required: false,
      defaultValue: "4546",
    }),
    defineField({
      key: "callback_url",
      type: "text",
      label: "Callback URL",
      description: "Optional delivery receipt webhook URL.",
      required: false,
    }),
  ],
});
