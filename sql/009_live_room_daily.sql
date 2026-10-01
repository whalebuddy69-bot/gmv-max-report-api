-- report_live_room_daily: LIVE room metrics per day.

CREATE TABLE IF NOT EXISTS report_live_room_daily (
  store_id      text NOT NULL,
  campaign_id   text NOT NULL,
  room_id       text NOT NULL,
  stat_date     date NOT NULL,
  advertiser_id text NOT NULL,

  live_name          text,
  live_status        text,   -- ONGOING | END
  live_launched_time text,   -- kept as TikTok sends it; format not guaranteed ISO
  live_duration      text,   -- TikTok sends this pre-formatted, e.g. "14h 1m"

  cost                    numeric(18,4),
  net_cost                numeric(18,4),
  orders                  integer,
  cost_per_order          numeric(18,4),
  gross_revenue           numeric(18,4),
  roi                     numeric(18,4),

  live_views              bigint,
  cost_per_live_view      numeric(18,4),
  live_views_10s          bigint,
  cost_per_live_view_10s  numeric(18,4),
  live_follows            integer,

  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, campaign_id, room_id, stat_date)
);

CREATE INDEX IF NOT EXISTS report_live_room_daily_date_idx
  ON report_live_room_daily (stat_date DESC, store_id);
