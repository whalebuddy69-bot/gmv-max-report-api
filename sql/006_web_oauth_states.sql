-- web_oauth_states: one-time state for the web TikTok OAuth flow.

CREATE TABLE IF NOT EXISTS web_oauth_states (
  state                text PRIMARY KEY,
  target_advertiser_id text NOT NULL,
  store_id             text,
  created_by_user_id   integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS web_oauth_states_expires_at_idx
  ON web_oauth_states (expires_at);
