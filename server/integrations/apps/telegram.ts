import type { AppManifest } from "../manifest";

export const telegramApp: AppManifest = {
  key: "telegram",
  name: "Telegram",
  version: "1.0.0",
  icon: "Send",
  category: "messaging",
  description: "Send each lead as a formatted message to a Telegram chat or channel.",
  adapterKey: "telegram",
  connectionType: "telegram_bot",
  modules: [{ key: "send_message", name: "Send message", kind: "action" }],
  availability: "stable",
};
