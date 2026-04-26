/**
 * Telegram dynamic option loaders.
 *
 * telegram.listChats  →  chat picker (depends on connectionId)
 *
 * Resolution:
 *   Validates the connection (ownership, type, active status), decrypts the
 *   bot token, then calls Telegram getUpdates to discover chats the bot has
 *   recently seen. Make.com uses the same getUpdates pattern.
 *
 * Limitation (same as Make.com):
 *   Only chats where the bot received at least one message in the last 24 h
 *   appear. Users must send /start (or any message) to the bot/group first.
 */

import axios from "axios";
import { and, eq } from "drizzle-orm";
import { connections } from "../../../drizzle/schema";
import { decrypt } from "../../encryption";
import { registerLoader } from "./registry";
import { LoaderValidationError, type LoadOptionsContext, type LoadOptionsResult } from "./types";

async function resolveBotToken(ctx: LoadOptionsContext): Promise<string> {
  if (ctx.connectionId == null) {
    throw LoaderValidationError.connectionRequired("Select a Telegram bot connection first.");
  }
  const [row] = await ctx.db
    .select()
    .from(connections)
    .where(and(eq(connections.id, ctx.connectionId), eq(connections.userId, ctx.userId)))
    .limit(1);

  if (!row) {
    throw LoaderValidationError.connectionInvalid("Connection not found or does not belong to you.");
  }
  if (row.type !== "telegram_bot") {
    throw LoaderValidationError.connectionInvalid(
      `Connection type is '${row.type}' — expected 'telegram_bot'.`,
    );
  }
  if (row.status !== "active") {
    throw LoaderValidationError.connectionInvalid(
      `Connection is '${row.status}'. Reconnect it before continuing.`,
    );
  }

  const creds = row.credentialsJson as { botTokenEncrypted?: string } | null;
  const encrypted = creds?.botTokenEncrypted;
  if (!encrypted) {
    throw LoaderValidationError.connectionInvalid("Connection is missing bot token — reconnect it.");
  }

  try {
    return decrypt(encrypted);
  } catch {
    throw LoaderValidationError.connectionInvalid("Failed to decrypt bot token — reconnect the bot.");
  }
}

interface TelegramUpdate {
  message?: { chat: TelegramChat };
  channel_post?: { chat: TelegramChat };
  my_chat_member?: { chat: TelegramChat };
  callback_query?: { message?: { chat: TelegramChat } };
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

function chatLabel(chat: TelegramChat): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  if (name) return name;
  if (chat.username) return `@${chat.username}`;
  return String(chat.id);
}

function chatTypeLabel(type: TelegramChat["type"]): string {
  const map: Record<TelegramChat["type"], string> = {
    private: "Private",
    group: "Group",
    supergroup: "Supergroup",
    channel: "Channel",
  };
  return map[type] ?? type;
}

async function listChats(ctx: LoadOptionsContext): Promise<LoadOptionsResult> {
  const token = await resolveBotToken(ctx);

  let updates: TelegramUpdate[] = [];
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
      params: { limit: 100, timeout: 0 },
      timeout: 8000,
    });
    if (res.data?.ok) {
      updates = res.data.result ?? [];
    }
  } catch {
    throw LoaderValidationError.externalApiError(
      "Could not fetch chats from Telegram — check bot token and try again.",
    );
  }

  // Collect unique chats from all update types.
  const seen = new Map<number, TelegramChat>();
  for (const u of updates) {
    const chat =
      u.message?.chat ??
      u.channel_post?.chat ??
      u.my_chat_member?.chat ??
      u.callback_query?.message?.chat;
    if (chat && !seen.has(chat.id)) {
      seen.set(chat.id, chat);
    }
  }

  if (seen.size === 0) {
    // Return an empty list with a helpful hint via a disabled sentinel option.
    return {
      options: [
        {
          value: "",
          label: "No chats found — send a message to the bot first, then refresh.",
        },
      ],
    };
  }

  // Sort: groups/channels first (most useful for lead delivery), then private.
  const priority: Record<TelegramChat["type"], number> = {
    channel: 0,
    supergroup: 1,
    group: 2,
    private: 3,
  };
  const getPriority = (t: unknown) => {
    if (typeof t === "string" && t in priority) return priority[t as TelegramChat["type"]];
    return 9;
  };
  const sorted = Array.from(seen.values()).sort(
    (a, b) => getPriority(a.type) - getPriority(b.type),
  );

  return {
    options: sorted.map((chat) => ({
      value: String(chat.id),
      label: `${chatLabel(chat)} (${chatTypeLabel(chat.type)})`,
      meta: { chatType: chat.type },
    })),
  };
}

export function registerTelegramLoaders(): void {
  registerLoader("telegram.listChats", listChats);
}

export const __testing = { listChats, resolveBotToken };
