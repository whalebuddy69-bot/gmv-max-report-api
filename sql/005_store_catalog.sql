-- store_catalog: latest /gmv_max/store/list/ result per advertiser.

CREATE TABLE IF NOT EXISTS store_catalog (
  advertiser_id               text        NOT NULL,
  store_id                    text        NOT NULL,
  store_name                  text,
  store_code                  text,
  is_gmv_max_available        boolean     NOT NULL DEFAULT false,
  store_status                text,
  exclusive_advertiser_id     text,
  exclusive_advertiser_name   text,
  store_authorized_bc_id      text,
  bc_name                     text,
  seen_at                     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (advertiser_id, store_id)
);

CREATE INDEX IF NOT EXISTS store_catalog_store_id_idx ON store_catalog (store_id);
