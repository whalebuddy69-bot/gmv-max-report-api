-- Additive cache only. Do not alter the shared bot tables or daily ad metrics.
CREATE TABLE IF NOT EXISTS report_video_metadata (
    item_id text PRIMARY KEY,
    username text,
    username_source text,
    posted_at timestamptz,
    posted_at_source text,
    checked_at timestamptz NOT NULL DEFAULT now(),
    next_check_at timestamptz NOT NULL DEFAULT now(),
    last_error text
);
CREATE INDEX IF NOT EXISTS idx_report_video_metadata_next_check
    ON report_video_metadata (next_check_at);
