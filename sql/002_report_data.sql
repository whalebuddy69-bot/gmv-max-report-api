-- Daily report tables filled by the sync job.

CREATE TABLE IF NOT EXISTS sync_targets (
  id             serial PRIMARY KEY,
  advertiser_id  text        NOT NULL,
  store_id       text        NOT NULL,
  store_name     text,
  enabled        boolean     NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (advertiser_id, store_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            uuid PRIMARY KEY,
  advertiser_id text        NOT NULL,
  store_id      text        NOT NULL,
  start_date    date        NOT NULL,
  end_date      date        NOT NULL,
  status        text        NOT NULL,          -- running | success | failed
  api_calls     integer     NOT NULL DEFAULT 0,
  row_counts    jsonb,
  error_message text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE INDEX IF NOT EXISTS sync_runs_store_started_idx
  ON sync_runs (store_id, started_at DESC);

CREATE TABLE IF NOT EXISTS report_campaign_daily (
  store_id            text NOT NULL,
  campaign_id         text NOT NULL,
  stat_date           date NOT NULL,
  advertiser_id       text NOT NULL,
  campaign_name       text,
  operation_status    text,
  bid_type            text,
  roas_bid            numeric(18,4),
  target_roi_budget   numeric(18,4),
  max_delivery_budget numeric(18,4),
  cost                numeric(18,4),
  net_cost            numeric(18,4),
  orders              integer,
  cost_per_order      numeric(18,4),
  gross_revenue       numeric(18,4),
  roi                 numeric(18,4),
  synced_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, campaign_id, stat_date)
);

CREATE INDEX IF NOT EXISTS report_campaign_daily_date_idx
  ON report_campaign_daily (stat_date DESC, store_id);

CREATE TABLE IF NOT EXISTS report_product_daily (
  store_id       text NOT NULL,
  campaign_id    text NOT NULL,
  item_group_id  text NOT NULL,
  stat_date      date NOT NULL,
  advertiser_id  text NOT NULL,
  product_name   text,
  product_status text,
  cost           numeric(18,4),
  orders         integer,
  cost_per_order numeric(18,4),
  gross_revenue  numeric(18,4),
  roi            numeric(18,4),
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, campaign_id, item_group_id, stat_date)
);

CREATE INDEX IF NOT EXISTS report_product_daily_date_idx
  ON report_product_daily (stat_date DESC, store_id);

CREATE TABLE IF NOT EXISTS report_creative_daily (
  store_id      text NOT NULL,
  campaign_id   text NOT NULL,
  item_group_id text NOT NULL,
  item_id       text NOT NULL,          -- '-1' = การ์ดสินค้า (product card)
  stat_date     date NOT NULL,
  advertiser_id text NOT NULL,

  title                         text,
  tt_account_name               text,
  tt_account_authorization_type text,   -- TTS_TT | AFFILIATE | TT_USER | BC_AUTH_TT | AUTH_CODE | UNSET
  shop_content_type             text,   -- VIDEO | PRODUCT_CARD
  creative_delivery_status      text,

  cost                    numeric(18,4),
  orders                  integer,
  cost_per_order          numeric(18,4),
  gross_revenue           numeric(18,4),
  roi                     numeric(18,4),
  product_impressions     bigint,
  product_clicks          bigint,
  product_click_rate      numeric(18,4),
  ad_click_rate           numeric(18,4),
  ad_conversion_rate      numeric(18,4),
  ad_video_view_rate_2s   numeric(18,4),
  ad_video_view_rate_6s   numeric(18,4),
  ad_video_view_rate_p25  numeric(18,4),
  ad_video_view_rate_p50  numeric(18,4),
  ad_video_view_rate_p75  numeric(18,4),
  ad_video_view_rate_p100 numeric(18,4),

  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, campaign_id, item_group_id, item_id, stat_date)
);

CREATE INDEX IF NOT EXISTS report_creative_daily_date_idx
  ON report_creative_daily (stat_date DESC, store_id);

CREATE INDEX IF NOT EXISTS report_creative_daily_account_idx
  ON report_creative_daily (tt_account_name, stat_date DESC)
  WHERE tt_account_name IS NOT NULL;
