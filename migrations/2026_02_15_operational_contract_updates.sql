begin;

create extension if not exists pgcrypto;

-- Ensure core sales lifecycle columns exist
alter table if exists public.sales
  add column if not exists status text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid,
  add column if not exists cancel_reason text,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists updated_by uuid;

update public.sales
set status = 'completed'
where status is null;

alter table if exists public.sales
  alter column status set default 'completed',
  alter column status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_status_check'
  ) then
    alter table public.sales
      add constraint sales_status_check check (status in ('completed', 'cancelled'));
  end if;
end $$;

-- New operational fields requested by frontend
alter table if exists public.sales
  add column if not exists currency text,
  add column if not exists fx_rate_used numeric,
  add column if not exists total_usd numeric,
  add column if not exists balance_due_ars numeric,
  add column if not exists notes text,
  add column if not exists includes_cube_20w boolean;

update public.sales
set currency = 'ARS'
where currency is null;

update public.sales
set includes_cube_20w = false
where includes_cube_20w is null;

alter table if exists public.sales
  alter column currency set default 'ARS',
  alter column currency set not null,
  alter column includes_cube_20w set default false,
  alter column includes_cube_20w set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_currency_check'
  ) then
    alter table public.sales
      add constraint sales_currency_check check (currency in ('ARS', 'USD'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_usd_fx_check'
  ) then
    alter table public.sales
      add constraint sales_usd_fx_check check (currency <> 'USD' or coalesce(fx_rate_used, 0) > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_total_ars_positive_check'
  ) then
    alter table public.sales
      add constraint sales_total_ars_positive_check check (total_ars > 0);
  end if;
end $$;

create index if not exists idx_sales_sale_date on public.sales (sale_date);
create index if not exists idx_sales_status on public.sales (status);

-- Ensure sale_items columns used by KPI logic exist
alter table if exists public.sale_items
  add column if not exists qty integer,
  add column if not exists subtotal_ars numeric,
  add column if not exists unit_cost_ars numeric;

update public.sale_items
set qty = 1
where qty is null or qty < 1;

update public.sale_items
set subtotal_ars = coalesce(qty, 1) * coalesce(sale_price_ars, 0)
where subtotal_ars is null;

update public.sale_items si
set unit_cost_ars = st.purchase_ars
from public.stock_items st
where st.id = si.stock_item_id
  and si.unit_cost_ars is null;

alter table if exists public.sale_items
  alter column qty set default 1,
  alter column qty set not null,
  alter column subtotal_ars set default 0,
  alter column subtotal_ars set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sale_items_qty_check'
  ) then
    alter table public.sale_items
      add constraint sale_items_qty_check check (qty >= 1);
  end if;
end $$;

create index if not exists idx_sale_items_sale_id on public.sale_items (sale_id);
create index if not exists idx_sale_items_stock_item_id on public.sale_items (stock_item_id);

-- Expand payment_method enum if sales.payment_method uses enum
DO $$
DECLARE
  v_data_type text;
  v_udt_name text;
BEGIN
  SELECT c.data_type, c.udt_name
  INTO v_data_type, v_udt_name
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'sales'
    AND c.column_name = 'payment_method';

  IF v_data_type = 'USER-DEFINED' AND v_udt_name IS NOT NULL THEN
    EXECUTE format('alter type public.%I add value if not exists %L', v_udt_name, 'mixed');
    EXECUTE format('alter type public.%I add value if not exists %L', v_udt_name, 'trade_in');
  END IF;
END $$;

-- stock_items operational fields
alter table if exists public.stock_items
  add column if not exists provider_name text,
  add column if not exists details text,
  add column if not exists received_at timestamptz,
  add column if not exists is_promo boolean default false,
  add column if not exists is_sealed boolean default false;

update public.stock_items set is_promo = false where is_promo is null;
update public.stock_items set is_sealed = false where is_sealed is null;

alter table if exists public.stock_items
  alter column is_promo set default false,
  alter column is_promo set not null,
  alter column is_sealed set default false,
  alter column is_sealed set not null;

-- Allow new operational statuses in stock_items.status
DO $$
DECLARE
  v_data_type text;
  v_udt_name text;
  v_constraint_name text;
BEGIN
  SELECT c.data_type, c.udt_name
  INTO v_data_type, v_udt_name
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'stock_items'
    AND c.column_name = 'status';

  IF v_data_type = 'USER-DEFINED' AND v_udt_name IS NOT NULL THEN
    EXECUTE format('alter type public.%I add value if not exists %L', v_udt_name, 'service_tech');
    EXECUTE format('alter type public.%I add value if not exists %L', v_udt_name, 'drawer');
  ELSE
    FOR v_constraint_name IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = 'stock_items'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ilike '%status%'
    LOOP
      EXECUTE format('alter table public.stock_items drop constraint %I', v_constraint_name);
    END LOOP;

    ALTER TABLE public.stock_items
      ADD CONSTRAINT stock_items_status_check
      CHECK (status in ('available', 'reserved', 'sold', 'service_tech', 'drawer'));
  END IF;
END $$;

-- trade_ins operational fields
alter table if exists public.trade_ins
  add column if not exists sale_ref text,
  add column if not exists customer_name text,
  add column if not exists customer_phone text;

create index if not exists idx_trade_ins_sale_ref on public.trade_ins (sale_ref);

-- warranties operational fields
alter table if exists public.warranties
  add column if not exists issue_reason text,
  add column if not exists replacement_stock_item_id uuid,
  add column if not exists replacement_device_label text,
  add column if not exists notes text,
  add column if not exists replaced_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'warranties_replacement_stock_item_fk'
  ) then
    alter table public.warranties
      add constraint warranties_replacement_stock_item_fk
      foreign key (replacement_stock_item_id)
      references public.stock_items(id)
      on delete set null;
  end if;
end $$;

-- installment_rules channel support
alter table if exists public.installment_rules
  add column if not exists channel text;

update public.installment_rules
set channel = 'standard'
where channel is null;

alter table if exists public.installment_rules
  alter column channel set default 'standard',
  alter column channel set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'installment_rules_channel_check'
  ) then
    alter table public.installment_rules
      add constraint installment_rules_channel_check
      check (channel in ('standard', 'mercado_pago'));
  end if;
end $$;

create index if not exists idx_installment_rules_channel on public.installment_rules (channel);

-- Optional matrix values for plan canje endpoint
create table if not exists public.plan_canje_values (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  min_price_ars numeric,
  max_price_ars numeric,
  trade_value_ars numeric,
  trade_value_pct numeric,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_plan_canje_values_active_sort
  on public.plan_canje_values (is_active, sort_order);

create table if not exists public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  route text not null,
  key text not null,
  request_hash text not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create unique index if not exists idx_idempotency_keys_unique
  on public.idempotency_keys (user_id, route, key);
create index if not exists idx_idempotency_keys_expires_at
  on public.idempotency_keys (expires_at);

create table if not exists public.sale_audit_logs (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  action text not null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  reason text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_sale_audit_logs_sale_id_created_at
  on public.sale_audit_logs (sale_id, created_at desc);

create or replace function public.rpc_create_sale_v2(
  p_payload jsonb,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_customer_id uuid;
  v_trade_in_id uuid;
  v_sale_date timestamptz;
  v_customer jsonb;
  v_payment jsonb;
  v_trade_in jsonb;
  v_item jsonb;
  v_stock_id uuid;
  v_qty integer;
  v_sale_price numeric;
  v_subtotal numeric;
  v_server_total numeric := 0;
  v_input_total numeric;
  v_payment_method_text text;
  v_payment_method public.payment_method;
  v_card_brand_text text;
  v_card_brand public.card_brand;
  v_installments integer;
  v_surcharge_pct numeric;
  v_deposit_ars numeric;
  v_currency text;
  v_fx_rate_used numeric;
  v_total_usd numeric;
  v_balance_due_ars numeric;
  v_notes text;
  v_includes_cube_20w boolean;
  v_stock record;
  v_warranty_days integer;
  v_customer_name text;
  v_customer_phone text;
begin
  v_sale_date := (p_payload->>'sale_date')::timestamptz;
  if v_sale_date is null then
    raise exception using message = 'validation_error', detail = 'sale_date_required';
  end if;

  if jsonb_typeof(p_payload->'items') <> 'array' or jsonb_array_length(p_payload->'items') = 0 then
    raise exception using message = 'validation_error', detail = 'items_required';
  end if;

  for v_item in select value from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := coalesce((v_item->>'qty')::integer, 1);
    v_sale_price := coalesce((v_item->>'sale_price_ars')::numeric, 0);
    if v_qty < 1 then
      raise exception using message = 'validation_error', detail = 'qty_must_be_gte_1';
    end if;
    if v_sale_price <= 0 then
      raise exception using message = 'validation_error', detail = 'sale_price_must_be_gt_0';
    end if;
    v_server_total := v_server_total + (v_qty * v_sale_price);
  end loop;

  if v_server_total <= 0 then
    raise exception using message = 'validation_error', detail = 'total_ars_must_be_gt_0';
  end if;

  v_input_total := nullif(p_payload->>'total_ars', '')::numeric;
  if v_input_total is not null and abs(v_input_total - v_server_total) > 0.01 then
    raise exception using message = 'total_mismatch', detail = format('input=%s server=%s', v_input_total, v_server_total);
  end if;

  v_customer_id := nullif(p_payload->>'customer_id', '')::uuid;
  v_customer := p_payload->'customer';

  if v_customer_id is null then
    if v_customer is null then
      raise exception using message = 'validation_error', detail = 'customer_or_customer_id_required';
    end if;
    v_customer_name := nullif(v_customer->>'name', '');
    v_customer_phone := nullif(v_customer->>'phone', '');
    if v_customer_name is null or v_customer_phone is null then
      raise exception using message = 'validation_error', detail = 'customer_name_and_phone_required';
    end if;

    select id into v_customer_id
    from public.customers
    where phone = v_customer_phone
    limit 1;

    if v_customer_id is null then
      insert into public.customers (name, phone)
      values (v_customer_name, v_customer_phone)
      returning id into v_customer_id;
    else
      update public.customers
      set name = v_customer_name
      where id = v_customer_id;
    end if;
  else
    if not exists (select 1 from public.customers where id = v_customer_id) then
      raise exception using message = 'not_found', detail = 'customer_not_found';
    end if;
  end if;

  v_payment := p_payload->'payment';
  v_payment_method_text := coalesce(nullif(p_payload->>'payment_method', ''), nullif(v_payment->>'method', ''), 'cash');
  begin
    v_payment_method := v_payment_method_text::public.payment_method;
  exception
    when invalid_text_representation then
      raise exception using message = 'validation_error', detail = format('invalid_payment_method:%s', v_payment_method_text);
  end;

  v_card_brand_text := coalesce(nullif(p_payload->>'card_brand', ''), nullif(v_payment->>'card_brand', ''));
  if v_card_brand_text is null then
    v_card_brand := null;
  else
    begin
      v_card_brand := v_card_brand_text::public.card_brand;
    exception
      when invalid_text_representation then
        raise exception using message = 'validation_error', detail = format('invalid_card_brand:%s', v_card_brand_text);
    end;
  end if;

  v_installments := coalesce(nullif(p_payload->>'installments', '')::integer, nullif(v_payment->>'installments', '')::integer);
  v_surcharge_pct := coalesce(nullif(p_payload->>'surcharge_pct', '')::numeric, nullif(v_payment->>'surcharge_pct', '')::numeric);
  v_deposit_ars := coalesce(nullif(p_payload->>'deposit_ars', '')::numeric, nullif(v_payment->>'deposit_ars', '')::numeric);

  v_currency := upper(coalesce(nullif(p_payload->>'currency', ''), 'ARS'));
  if v_currency not in ('ARS', 'USD') then
    raise exception using message = 'validation_error', detail = format('invalid_currency:%s', v_currency);
  end if;

  v_fx_rate_used := nullif(p_payload->>'fx_rate_used', '')::numeric;
  if v_currency = 'USD' and coalesce(v_fx_rate_used, 0) <= 0 then
    raise exception using message = 'validation_error', detail = 'fx_rate_used_required_for_usd';
  end if;

  v_total_usd := nullif(p_payload->>'total_usd', '')::numeric;
  if v_total_usd is null and v_currency = 'USD' and coalesce(v_fx_rate_used, 0) > 0 then
    v_total_usd := round(v_server_total / v_fx_rate_used, 2);
  end if;

  v_balance_due_ars := coalesce(nullif(p_payload->>'balance_due_ars', '')::numeric, greatest(v_server_total - coalesce(v_deposit_ars, 0), 0));
  v_notes := nullif(p_payload->>'notes', '');
  v_includes_cube_20w := coalesce((p_payload->>'includes_cube_20w')::boolean, false);

  insert into public.sales (
    sale_date,
    customer_id,
    payment_method,
    card_brand,
    installments,
    surcharge_pct,
    deposit_ars,
    total_ars,
    created_by,
    status,
    updated_at,
    updated_by,
    currency,
    fx_rate_used,
    total_usd,
    balance_due_ars,
    notes,
    includes_cube_20w
  ) values (
    v_sale_date,
    v_customer_id,
    v_payment_method,
    v_card_brand,
    v_installments,
    v_surcharge_pct,
    v_deposit_ars,
    v_server_total,
    p_user_id,
    'completed',
    now(),
    p_user_id,
    v_currency,
    v_fx_rate_used,
    v_total_usd,
    v_balance_due_ars,
    v_notes,
    v_includes_cube_20w
  )
  returning id into v_sale_id;

  for v_item in select value from jsonb_array_elements(p_payload->'items')
  loop
    v_stock_id := (v_item->>'stock_item_id')::uuid;
    v_qty := coalesce((v_item->>'qty')::integer, 1);
    v_sale_price := (v_item->>'sale_price_ars')::numeric;
    v_subtotal := v_qty * v_sale_price;

    if v_qty <> 1 then
      raise exception using message = 'validation_error', detail = format('qty_not_supported_for_serialized_stock:%s', v_stock_id);
    end if;

    select id, status, purchase_ars, coalesce(warranty_days, warranty_days_default, 90) as warranty_days
      into v_stock
    from public.stock_items
    where id = v_stock_id
    for update;

    if not found then
      raise exception using message = 'not_found', detail = format('stock_item_not_found:%s', v_stock_id);
    end if;

    if v_stock.status <> 'available' then
      raise exception using message = 'stock_unavailable', detail = format('%s:%s', v_stock_id, v_stock.status);
    end if;

    insert into public.sale_items (
      sale_id,
      stock_item_id,
      qty,
      sale_price_ars,
      subtotal_ars,
      unit_cost_ars
    ) values (
      v_sale_id,
      v_stock_id,
      v_qty,
      v_sale_price,
      v_subtotal,
      v_stock.purchase_ars
    );

    update public.stock_items
      set status = 'sold'
    where id = v_stock_id;

    v_warranty_days := coalesce(v_stock.warranty_days, 90);
    insert into public.warranties (
      sale_id,
      stock_item_id,
      customer_id,
      start_date,
      end_date,
      warranty_days,
      warranty_start,
      warranty_end
    ) values (
      v_sale_id,
      v_stock_id,
      v_customer_id,
      v_sale_date::date,
      (v_sale_date::date + v_warranty_days),
      v_warranty_days,
      v_sale_date::date,
      (v_sale_date::date + v_warranty_days)
    );
  end loop;

  v_trade_in := p_payload->'trade_in';
  if coalesce((v_trade_in->>'enabled')::boolean, false) then
    insert into public.trade_ins (
      sale_id,
      device,
      trade_value_usd,
      fx_rate_used,
      status,
      customer_name,
      customer_phone,
      sale_ref
    ) values (
      v_sale_id,
      coalesce(v_trade_in->'device', '{}'::jsonb),
      coalesce((v_trade_in->>'trade_value_usd')::numeric, 0),
      coalesce((v_trade_in->>'fx_rate_used')::numeric, 0),
      'valued',
      v_customer_name,
      v_customer_phone,
      v_sale_id::text
    )
    returning id into v_trade_in_id;
  end if;

  insert into public.sale_audit_logs (sale_id, action, actor_user_id, payload)
  values (v_sale_id, 'created', p_user_id, p_payload);

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'trade_in_id', v_trade_in_id,
    'customer_id', v_customer_id,
    'total_ars', v_server_total,
    'server_total_ars', v_server_total,
    'currency', v_currency,
    'fx_rate_used', v_fx_rate_used,
    'total_usd', v_total_usd,
    'balance_due_ars', v_balance_due_ars,
    'notes', v_notes,
    'includes_cube_20w', v_includes_cube_20w
  );
end;
$$;

create or replace function public.rpc_update_sale_v2(
  p_sale_id uuid,
  p_payload jsonb,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
  v_sale_date timestamptz;
  v_customer jsonb;
  v_payment jsonb;
  v_item jsonb;
  v_items jsonb;
  v_customer_id uuid;
  v_total_ars numeric := 0;
  v_input_total numeric;
  v_payment_method_text text;
  v_payment_method public.payment_method;
  v_card_brand_text text;
  v_card_brand public.card_brand;
  v_installments integer;
  v_surcharge_pct numeric;
  v_deposit_ars numeric;
  v_currency text;
  v_fx_rate_used numeric;
  v_total_usd numeric;
  v_balance_due_ars numeric;
  v_notes text;
  v_includes_cube_20w boolean;
  v_qty integer;
  v_sale_price numeric;
  v_subtotal numeric;
  v_stock_id uuid;
  v_stock record;
  v_warranty_days integer;
  v_customer_name text;
  v_customer_phone text;
begin
  select *
    into v_sale
  from public.sales
  where id = p_sale_id
  for update;

  if not found then
    raise exception using message = 'not_found', detail = 'sale_not_found';
  end if;

  if v_sale.status = 'cancelled' then
    raise exception using message = 'conflict', detail = 'sale_already_cancelled';
  end if;

  v_sale_date := coalesce((p_payload->>'sale_date')::timestamptz, v_sale.sale_date);
  v_customer_id := coalesce(nullif(p_payload->>'customer_id', '')::uuid, v_sale.customer_id);
  v_customer := p_payload->'customer';

  if v_customer is not null then
    v_customer_name := nullif(v_customer->>'name', '');
    v_customer_phone := nullif(v_customer->>'phone', '');
    if v_customer_name is null or v_customer_phone is null then
      raise exception using message = 'validation_error', detail = 'customer_name_and_phone_required';
    end if;

    select id into v_customer_id
    from public.customers
    where phone = v_customer_phone
    limit 1;

    if v_customer_id is null then
      insert into public.customers (name, phone)
      values (v_customer_name, v_customer_phone)
      returning id into v_customer_id;
    else
      update public.customers
      set name = v_customer_name
      where id = v_customer_id;
    end if;
  end if;

  v_payment := p_payload->'payment';
  v_payment_method_text := coalesce(nullif(p_payload->>'payment_method', ''), nullif(v_payment->>'method', ''), v_sale.payment_method::text, 'cash');
  begin
    v_payment_method := v_payment_method_text::public.payment_method;
  exception
    when invalid_text_representation then
      raise exception using message = 'validation_error', detail = format('invalid_payment_method:%s', v_payment_method_text);
  end;

  v_card_brand_text := coalesce(nullif(p_payload->>'card_brand', ''), nullif(v_payment->>'card_brand', ''), v_sale.card_brand::text);
  if v_card_brand_text is null then
    v_card_brand := null;
  else
    begin
      v_card_brand := v_card_brand_text::public.card_brand;
    exception
      when invalid_text_representation then
        raise exception using message = 'validation_error', detail = format('invalid_card_brand:%s', v_card_brand_text);
    end;
  end if;

  v_installments := coalesce(nullif(p_payload->>'installments', '')::integer, nullif(v_payment->>'installments', '')::integer, v_sale.installments);
  v_surcharge_pct := coalesce(nullif(p_payload->>'surcharge_pct', '')::numeric, nullif(v_payment->>'surcharge_pct', '')::numeric, v_sale.surcharge_pct);
  v_deposit_ars := coalesce(nullif(p_payload->>'deposit_ars', '')::numeric, nullif(v_payment->>'deposit_ars', '')::numeric, v_sale.deposit_ars);

  v_currency := upper(coalesce(nullif(p_payload->>'currency', ''), v_sale.currency, 'ARS'));
  if v_currency not in ('ARS', 'USD') then
    raise exception using message = 'validation_error', detail = format('invalid_currency:%s', v_currency);
  end if;

  v_fx_rate_used := coalesce(nullif(p_payload->>'fx_rate_used', '')::numeric, v_sale.fx_rate_used);
  if v_currency = 'USD' and coalesce(v_fx_rate_used, 0) <= 0 then
    raise exception using message = 'validation_error', detail = 'fx_rate_used_required_for_usd';
  end if;

  v_items := p_payload->'items';

  if v_items is null then
    select coalesce(sum(subtotal_ars), 0) into v_total_ars
    from public.sale_items
    where sale_id = p_sale_id;
  else
    if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
      raise exception using message = 'validation_error', detail = 'items_required';
    end if;

    update public.stock_items
    set status = 'available'
    where id in (
      select stock_item_id
      from public.sale_items
      where sale_id = p_sale_id
    );

    delete from public.warranties where sale_id = p_sale_id;
    delete from public.sale_items where sale_id = p_sale_id;

    for v_item in select value from jsonb_array_elements(v_items)
    loop
      v_qty := coalesce((v_item->>'qty')::integer, 1);
      v_sale_price := coalesce((v_item->>'sale_price_ars')::numeric, 0);
      v_stock_id := (v_item->>'stock_item_id')::uuid;

      if v_qty < 1 then
        raise exception using message = 'validation_error', detail = 'qty_must_be_gte_1';
      end if;
      if v_sale_price <= 0 then
        raise exception using message = 'validation_error', detail = 'sale_price_must_be_gt_0';
      end if;
      if v_qty <> 1 then
        raise exception using message = 'validation_error', detail = format('qty_not_supported_for_serialized_stock:%s', v_stock_id);
      end if;

      select id, status, purchase_ars, coalesce(warranty_days, warranty_days_default, 90) as warranty_days
        into v_stock
      from public.stock_items
      where id = v_stock_id
      for update;

      if not found then
        raise exception using message = 'not_found', detail = format('stock_item_not_found:%s', v_stock_id);
      end if;

      if v_stock.status <> 'available' then
        raise exception using message = 'stock_unavailable', detail = format('%s:%s', v_stock_id, v_stock.status);
      end if;

      v_subtotal := v_qty * v_sale_price;
      v_total_ars := v_total_ars + v_subtotal;

      insert into public.sale_items (
        sale_id,
        stock_item_id,
        qty,
        sale_price_ars,
        subtotal_ars,
        unit_cost_ars
      ) values (
        p_sale_id,
        v_stock_id,
        v_qty,
        v_sale_price,
        v_subtotal,
        v_stock.purchase_ars
      );

      update public.stock_items
        set status = 'sold'
      where id = v_stock_id;

      v_warranty_days := coalesce(v_stock.warranty_days, 90);
      insert into public.warranties (
        sale_id,
        stock_item_id,
        customer_id,
        start_date,
        end_date,
        warranty_days,
        warranty_start,
        warranty_end
      ) values (
        p_sale_id,
        v_stock_id,
        v_customer_id,
        v_sale_date::date,
        (v_sale_date::date + v_warranty_days),
        v_warranty_days,
        v_sale_date::date,
        (v_sale_date::date + v_warranty_days)
      );
    end loop;
  end if;

  if v_total_ars <= 0 then
    raise exception using message = 'validation_error', detail = 'total_ars_must_be_gt_0';
  end if;

  v_input_total := nullif(p_payload->>'total_ars', '')::numeric;
  if v_input_total is not null and abs(v_input_total - v_total_ars) > 0.01 then
    raise exception using message = 'total_mismatch', detail = format('input=%s server=%s', v_input_total, v_total_ars);
  end if;

  v_total_usd := coalesce(nullif(p_payload->>'total_usd', '')::numeric, v_sale.total_usd);
  if v_total_usd is null and v_currency = 'USD' and coalesce(v_fx_rate_used, 0) > 0 then
    v_total_usd := round(v_total_ars / v_fx_rate_used, 2);
  end if;

  v_balance_due_ars := coalesce(nullif(p_payload->>'balance_due_ars', '')::numeric, greatest(v_total_ars - coalesce(v_deposit_ars, 0), 0));
  v_notes := coalesce(nullif(p_payload->>'notes', ''), v_sale.notes);
  v_includes_cube_20w := coalesce((p_payload->>'includes_cube_20w')::boolean, v_sale.includes_cube_20w, false);

  update public.sales
  set
    sale_date = v_sale_date,
    customer_id = v_customer_id,
    payment_method = v_payment_method,
    card_brand = v_card_brand,
    installments = v_installments,
    surcharge_pct = v_surcharge_pct,
    deposit_ars = v_deposit_ars,
    total_ars = v_total_ars,
    updated_at = now(),
    updated_by = p_user_id,
    currency = v_currency,
    fx_rate_used = v_fx_rate_used,
    total_usd = v_total_usd,
    balance_due_ars = v_balance_due_ars,
    notes = v_notes,
    includes_cube_20w = v_includes_cube_20w
  where id = p_sale_id;

  insert into public.sale_audit_logs (sale_id, action, actor_user_id, payload)
  values (p_sale_id, 'updated', p_user_id, p_payload);

  return jsonb_build_object(
    'sale_id', p_sale_id,
    'customer_id', v_customer_id,
    'total_ars', v_total_ars,
    'server_total_ars', v_total_ars,
    'status', 'completed',
    'currency', v_currency,
    'fx_rate_used', v_fx_rate_used,
    'total_usd', v_total_usd,
    'balance_due_ars', v_balance_due_ars,
    'notes', v_notes,
    'includes_cube_20w', v_includes_cube_20w
  );
end;
$$;

commit;
