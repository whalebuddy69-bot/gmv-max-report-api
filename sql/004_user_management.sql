-- users: soft delete and forced logout on password change.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();
