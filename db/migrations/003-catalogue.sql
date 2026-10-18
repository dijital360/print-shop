-- Managed tariffs are separate from immutable order snapshots and legacy rates.
CREATE TABLE IF NOT EXISTS print_shop.catalogue_products (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Version 3 is recorded by initialize() in the same transaction as the one-time
-- authorized Branda seed. Restarting never restores an archived/edited tariff.
