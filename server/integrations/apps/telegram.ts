import type { AppManifest } from "../manifest";

/**
 * Variables available inside messageTemplate placeholders, expanded at delivery
 * time by server/integrations/adapters/telegramAdapter.ts. Kept here (not
 * hard-coded into the UI) so that Commit 3's variable-picker sidebar can list
 * them directly from the manifest instead of duplicating the catalogue.
 */
const TELEGRAM_TEMPLATE_VARIABLES = [
  "full_name",
  "phone_number",
  "email",
  "pageName",
  "formName",
  "campaignName",
  "createdAt",
] as const;

const DEFAULT_MESSAGE_TEMPLATE =
  "\ud83d\udccb Yangi lead\n\n\ud83d\udc64 Ism: {{full_name}}\n\ud83d\udcde Telefon: {{phone_number}}\n\ud83d\udce7 Email: {{email}}";

export const telegramApp: AppManifest = {
  key: "telegram",
  name: "Telegram",
  version: "1.1.0",
  icon: "Send",
  category: "messaging",
  description: "Send each lead as a formatted message to a Telegram chat or channel.",
  adapterKey: "telegram",
  connectionType: "telegram_bot",
  modules: [
    {
      key: "send_message",
      name: "Send message",
      kind: "action",
      description: "Post a templated message to a Telegram chat each time a new lead arrives.",
      fields: [
        {
          key: "connectionId",
          type: "connection-picker",
          label: "Telegram bot",
          description: "Pick a bot from your Connections, or add a new one.",
          required: true,
          connectionType: "telegram_bot",
        },
        {
          key: "chatId",
          type: "text",
          label: "Chat ID",
          description:
            "Leave blank to use the default chat stored on the connection. Override to send to a different channel.",
          required: false,
          placeholder: "-1001234567890",
          validation: { maxLength: 64 },
        },
        {
          key: "messageTemplate",
          type: "textarea",
          label: "Message template",
          description: `Available variables: ${TELEGRAM_TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}`,
          required: false,
          defaultValue: DEFAULT_MESSAGE_TEMPLATE,
          validation: { maxLength: 4000 },
        },
      ],
    },
  ],
  availability: "stable",
};
