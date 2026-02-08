begin;

alter table if exists public.stock_items
  add column if not exists sale_price_usd numeric,
  add column if not exists battery_pct integer,
  add column if not exists storage_gb integer,
  add column if not exists color text,
  add column if not exists color_other text,
  add column if not exists warranty_days integer;

-- Backfill warranty_days from old column if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_items'
      AND column_name = 'warranty_days_default'
  ) THEN
    EXECUTE 'UPDATE public.stock_items
             SET warranty_days = warranty_days_default
             WHERE warranty_days IS NULL
               AND warranty_days_default IS NOT NULL';
  END IF;
END $$;

commit;
