-- LIVE campaign metrics on report_campaign_daily.

ALTER TABLE report_campaign_daily
  ADD COLUMN IF NOT EXISTS tt_account_name             text,
  ADD COLUMN IF NOT EXISTS tt_account_profile_image_url text,
  ADD COLUMN IF NOT EXISTS identity_id                 text,
  ADD COLUMN IF NOT EXISTS live_views                   bigint,
  ADD COLUMN IF NOT EXISTS cost_per_live_view           numeric(18,4),
  ADD COLUMN IF NOT EXISTS live_views_10s               bigint,
  ADD COLUMN IF NOT EXISTS cost_per_live_view_10s       numeric(18,4),
  ADD COLUMN IF NOT EXISTS live_follows                 integer;
