-- Rollback for 0076 — re-create the 6 back-compat VIEWs.

CREATE OR REPLACE VIEW ad_accounts_cache AS SELECT * FROM ad_accounts;
CREATE OR REPLACE VIEW campaigns_cache AS SELECT * FROM campaigns;
CREATE OR REPLACE VIEW ad_sets_cache AS SELECT * FROM ad_sets;
CREATE OR REPLACE VIEW campaign_insights_cache AS SELECT * FROM campaign_insights;
CREATE OR REPLACE VIEW integration_health AS SELECT * FROM circuit_breakers;
CREATE OR REPLACE VIEW integration_health_events AS SELECT * FROM circuit_breaker_events;
