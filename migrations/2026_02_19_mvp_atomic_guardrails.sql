begin;

-- Ensure referential integrity for sale_items
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sale_items_sale_id_fk'
  ) then
    alter table public.sale_items
      add constraint sale_items_sale_id_fk
      foreign key (sale_id)
      references public.sales(id)
      on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'sale_items_stock_item_id_fk'
  ) then
    alter table public.sale_items
      add constraint sale_items_stock_item_id_fk
      foreign key (stock_item_id)
      references public.stock_items(id)
      on delete restrict;
  end if;
end $$;

-- Query performance indexes
create index if not exists idx_sales_sale_date on public.sales (sale_date);
create index if not exists idx_sale_items_stock_item_id on public.sale_items (stock_item_id);
create index if not exists idx_sale_items_sale_id on public.sale_items (sale_id);
create index if not exists idx_sale_payments_sale_id_created_at on public.sale_payments (sale_id, created_at desc);

-- Stock status validity guard (for text-based status columns)
do $$
declare
  v_data_type text;
  v_constraint_name text;
begin
  select c.data_type
  into v_data_type
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'stock_items'
    and c.column_name = 'status';

  if v_data_type = 'text' then
    for v_constraint_name in
      select conname
      from pg_constraint pc
      join pg_class t on t.oid = pc.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname = 'stock_items'
        and pc.contype = 'c'
        and pg_get_constraintdef(pc.oid) ilike '%status%'
    loop
      execute format('alter table public.stock_items drop constraint %I', v_constraint_name);
    end loop;

    alter table public.stock_items
      add constraint stock_items_status_check
      check (status in ('available', 'reserved', 'sold', 'service_tech', 'drawer'));
  end if;
end $$;

commit;
