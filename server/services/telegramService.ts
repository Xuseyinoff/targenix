import axios from "axios";

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export interface LeadNotificationData {
  leadgenId: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  pageId: string;
  formId: string;
  createdAt: Date;
}

/**
 * Format a lead into a readable Telegram message.
 */
function formatLeadMessage(lead: LeadNotificationData): string {
  const lines: string[] = [
    "📋 *New Facebook Lead*",
    "",
    `👤 *Name:* ${lead.fullName || "N/A"}`,
    `📞 *Phone:* ${lead.phone || "N/A"}`,
    `📧 *Email:* ${lead.email || "N/A"}`,
    "",
    `📄 *Form ID:* \`${lead.formId}\``,
    `📄 *Page ID:* \`${lead.pageId}\``,
    `🆔 *Lead ID:* \`${lead.leadgenId}\``,
    `🕐 *Time:* ${new Date(lead.createdAt).toLocaleString()}`,
  ];
  return lines.join("\n");
}

/**
 * Send a lead notification to a Telegram chat.
 * Returns true on success, false on failure.
 */
export async function sendTelegramNotification(
  config: TelegramConfig,
  lead: LeadNotificationData
): Promise<{ success: boolean; error?: string }> {
  const text = formatLeadMessage(lead);
  const url = `https://api.telegram.org/bot${config.token}/sendMessage`;

  try {
    await axios.post(
      url,
      {
        chat_id: config.chatId,
        text,
        parse_mode: "Markdown",
      },
      { timeout: 10000 }
    );
    console.log(`[Telegram] Notification sent to chat ${config.chatId}`);
    return { success: true };
  } catch (err: any) {
    const error = err?.response?.data?.description || err.message;
    console.error(`[Telegram] Failed to send notification:`, error);
    return { success: false, error };
  }
}

/**
 * Validate a Telegram bot token by calling getMe.
 */
export async function validateTelegramToken(token: string): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${token}/getMe`;
    const res = await axios.get(url, { timeout: 5000 });
    return res.data?.ok === true;
  } catch {
    return false;
  }
}
