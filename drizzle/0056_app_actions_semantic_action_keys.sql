-- Migration 0056 — Make `app_actions.actionKey` semantic for a few legacy rows.
--
-- Why:
--   These five rows were created by 0048 mirror logic as t{templateId}. They are
--   hard to read and user-hostile if ever surfaced. We rename only the exact keys
--   t1..t5 to meaningful names.
--
-- Safety:
--   - Updates only 5 known keys; UNIQUE(appKey, actionKey) remains intact.
--   - Code keeps a backward-compat lookup (tries semantic then legacy).
--
-- Rollback:
--   Run 0057_app_actions_semantic_action_keys_rollback.sql

--> statement-breakpoint
UPDATE `app_actions`
SET `actionKey` = CASE `actionKey`
  WHEN 't1' THEN 'send_lead'
  WHEN 't2' THEN 'append_row'
  WHEN 't3' THEN 'send_message'
  WHEN 't4' THEN 'create_contact'
  WHEN 't5' THEN 'update_deal'
  ELSE `actionKey`
END;

