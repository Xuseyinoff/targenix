-- Rollback for 0075 — restore legacy index names. Same 13 ALTER pairs in reverse.

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ad_accounts' AND index_name = 'uq_ad_accounts_user_account');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ad_accounts' AND index_name = 'uq_ad_accounts_cache_user_account');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE ad_accounts RENAME INDEX uq_ad_accounts_user_account TO uq_ad_accounts_cache_user_account', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ad_accounts' AND index_name = 'idx_ad_accounts_fb_account');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ad_accounts' AND index_name = 'idx_ad_accounts_cache_fb_account');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE ad_accounts RENAME INDEX idx_ad_accounts_fb_account TO idx_ad_accounts_cache_fb_account', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'campaigns' AND index_name = 'uq_campaigns_user_campaign');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'campaigns' AND index_name = 'uq_campaigns_cache_user_campaign');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE campaigns RENAME INDEX uq_campaigns_user_campaign TO uq_campaigns_cache_user_campaign', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'campaigns' AND index_name = 'idx_campaigns_user_ad_account');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'campaigns' AND index_name = 'idx_campaigns_cache_user_ad_account');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE campaigns RENAME INDEX idx_campaigns_user_ad_account TO idx_campaigns_cache_user_ad_account', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ad_sets' AND index_name = 'uq_ad_sets_user_adset');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ad_sets' AND index_name = 'uq_ad_sets_cache_user_adset');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE ad_sets RENAME INDEX uq_ad_sets_user_adset TO uq_ad_sets_cache_user_adset', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ad_sets' AND index_name = 'idx_ad_sets_user_campaign');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ad_sets' AND index_name = 'idx_ad_sets_cache_user_campaign');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE ad_sets RENAME INDEX idx_ad_sets_user_campaign TO idx_ad_sets_cache_user_campaign', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'campaign_insights' AND index_name = 'uq_campaign_insights_key');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'campaign_insights' AND index_name = 'uq_campaign_insights_cache_key');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE campaign_insights RENAME INDEX uq_campaign_insights_key TO uq_campaign_insights_cache_key', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'campaign_insights' AND index_name = 'idx_campaign_insights_account');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'campaign_insights' AND index_name = 'idx_campaign_insights_cache_account');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE campaign_insights RENAME INDEX idx_campaign_insights_account TO idx_campaign_insights_cache_account', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers' AND index_name = 'uq_circuit_breakers_dest');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers' AND index_name = 'uq_integration_health_dest');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE circuit_breakers RENAME INDEX uq_circuit_breakers_dest TO uq_integration_health_dest', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers' AND index_name = 'idx_circuit_breakers_state');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers' AND index_name = 'idx_integration_health_state');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE circuit_breakers RENAME INDEX idx_circuit_breakers_state TO idx_integration_health_state', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers' AND index_name = 'idx_circuit_breakers_appkey_state');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers' AND index_name = 'idx_integration_health_appkey_state');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE circuit_breakers RENAME INDEX idx_circuit_breakers_appkey_state TO idx_integration_health_appkey_state', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events' AND index_name = 'idx_cb_events_dest_time');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events' AND index_name = 'idx_ih_events_dest_time');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE circuit_breaker_events RENAME INDEX idx_cb_events_dest_time TO idx_ih_events_dest_time', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

SET @s := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events' AND index_name = 'idx_cb_events_type_time');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events' AND index_name = 'idx_ih_events_type_time');
SET @q := IF(@s >= 1 AND @d = 0, 'ALTER TABLE circuit_breaker_events RENAME INDEX idx_cb_events_type_time TO idx_ih_events_type_time', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;
