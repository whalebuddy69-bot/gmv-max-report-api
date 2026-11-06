-- Optional, additive, one-shot Creator test ledger. Never reset a send fence.
-- Apply only during explicitly authorized writer bootstrap; disabled Report needs no table.
CREATE TABLE IF NOT EXISTS creator_budget_test_operations (
  permit_id text PRIMARY KEY CHECK (permit_id ~ '^[A-Za-z0-9_-]{8,100}$'),
  client_id text NOT NULL CHECK (client_id = 'punpan_020'),
  local_date date NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  permit jsonb NOT NULL,
  baseline jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('SEND_RESERVED','SUCCEEDED','FAILED_REJECTED','FAILED_NOT_SENT',
    'OUTCOME_UNKNOWN','RECONCILED_TARGET_OBSERVED','CONFLICT_OBSERVED')),
  post_count smallint NOT NULL DEFAULT 1 CHECK (post_count = 1),
  provider_accepted boolean,
  observed_budget_minor bigint CHECK (observed_budget_minor >= 0),
  reason text NOT NULL CHECK (reason ~ '^[A-Z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, local_date)
);
