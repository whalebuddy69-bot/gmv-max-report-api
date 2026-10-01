-- users: web app accounts.

CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  name          text,
  role          text        NOT NULL DEFAULT 'viewer',   -- viewer | admin
  is_active     boolean     NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
