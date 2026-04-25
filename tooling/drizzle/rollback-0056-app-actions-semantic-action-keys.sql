-- Manual rollback for migration 0056_app_actions_semantic_action_keys
UPDATE `app_actions`
SET `actionKey` = CASE `actionKey`
  WHEN 'send_lead' THEN 't1'
  WHEN 'append_row' THEN 't2'
  WHEN 'send_message' THEN 't3'
  WHEN 'create_contact' THEN 't4'
  WHEN 'update_deal' THEN 't5'
  ELSE `actionKey`
END;

