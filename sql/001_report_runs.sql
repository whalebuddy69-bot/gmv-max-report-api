-- report_runs: one row per generated Excel report.

CREATE TABLE IF NOT EXISTS report_runs (
  id            uuid PRIMARY KEY,
  advertiser_id text        NOT NULL,
  store_ids     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  start_date    date        NOT NULL,
  end_date      date        NOT NULL,
  status        text        NOT NULL,          -- pending | success | failed
  file_path     text,
  file_name     text,
  row_counts    jsonb,                         -- { overall, productCard, skippedVideos }
  warnings      jsonb,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  generated_at  timestamptz
);

CREATE INDEX IF NOT EXISTS report_runs_advertiser_created_idx
  ON report_runs (advertiser_id, created_at DESC);
