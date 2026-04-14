-- Drop unused Telegram tables from old confirm/session flows.
-- Current delivery linking is via chatId paste + bot admin verification.

DROP TABLE IF EXISTS `telegram_linking_session_chats`;
--> statement-breakpoint
DROP TABLE IF EXISTS `telegram_linking_sessions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `telegram_chat_connect_tokens`;
--> statement-breakpoint
DROP TABLE IF EXISTS `telegram_chat_integrations`;