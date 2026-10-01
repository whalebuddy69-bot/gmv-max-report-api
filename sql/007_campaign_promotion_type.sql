-- report_campaign_daily.promotion_type (PRODUCT | LIVE).

ALTER TABLE report_campaign_daily
  ADD COLUMN IF NOT EXISTS promotion_type text NOT NULL DEFAULT 'PRODUCT';

CREATE INDEX IF NOT EXISTS report_campaign_daily_promotion_type_idx
  ON report_campaign_daily (promotion_type, stat_date DESC, store_id);
