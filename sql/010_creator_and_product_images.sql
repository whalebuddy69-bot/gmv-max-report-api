-- Creator avatar and product image columns.

ALTER TABLE report_creative_daily
  ADD COLUMN IF NOT EXISTS tt_account_profile_image_url text;

ALTER TABLE report_product_daily
  ADD COLUMN IF NOT EXISTS product_image_url text;
