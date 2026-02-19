begin;

create extension if not exists pgcrypto;

-- profiles.role supports owner
do $$
declare
  v_data_type text;
  v_udt_name text;
  v_constraint_name text;
begin
  select c.data_type, c.udt_name
  into v_data_type, v_udt_name
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'profiles'
    and c.column_name = 'role';

  if v_data_type = 'USER-DEFINED' and v_udt_name is not null then
    execute format('alter type public.%I add value if not exists %L', v_udt_name, 'owner');
  else
    for v_constraint_name in
      select conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and t.relname = 'profiles'
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) ilike '%role%'
    loop
      execute format('alter table public.profiles drop constraint %I', v_constraint_name);
    end loop;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'role'
    ) then
      alter table public.profiles
        add constraint profiles_role_check
        check (role in ('seller', 'admin', 'owner'));
    end if;
  end if;
end $$;

-- sales operational/receivables fields
alter table if exists public.sales
  add column if not exists seller_id uuid,
  add column if not exists details text,
  add column if not exists paid_ars numeric,
  add column if not exists receivable_status text;

update public.sales
set paid_ars = coalesce(paid_ars, 0)
where paid_ars is null;

update public.sales
set balance_due_ars = greatest(coalesce(total_ars, 0) - coalesce(paid_ars, 0), 0)
where balance_due_ars is null;

update public.sales
set receivable_status = case
  when coalesce(balance_due_ars, 0) <= 0 then 'paid'
  when coalesce(paid_ars, 0) > 0 then 'partial'
  else 'pending'
end
where receivable_status is null;

alter table if exists public.sales
  alter column paid_ars set default 0,
  alter column paid_ars set not null,
  alter column receivable_status set default 'pending',
  alter column receivable_status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sales_seller_id_fk'
  ) then
    alter table public.sales
      add constraint sales_seller_id_fk
      foreign key (seller_id)
      references public.profiles(id)
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'sales_receivable_status_check'
  ) then
    alter table public.sales
      add constraint sales_receivable_status_check
      check (receivable_status in ('pending', 'partial', 'paid'));
  end if;
end $$;

create index if not exists idx_sales_seller_id on public.sales (seller_id);
create index if not exists idx_sales_receivable_status on public.sales (receivable_status);

-- stock sale linkage for anti-ghost stock
alter table if exists public.stock_items
  add column if not exists sale_id uuid,
  add column if not exists sold_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stock_items_sale_id_fk'
  ) then
    alter table public.stock_items
      add constraint stock_items_sale_id_fk
      foreign key (sale_id)
      references public.sales(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_stock_items_status_imei on public.stock_items (status, imei);
create index if not exists idx_stock_items_sale_id on public.stock_items (sale_id);

-- sale payments
create table if not exists public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  method text not null,
  currency text not null default 'ARS',
  amount numeric not null,
  card_brand text,
  installments integer,
  surcharge_pct numeric,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table if exists public.sale_payments
  add column if not exists created_by uuid references public.profiles(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sale_payments_method_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_method_check
      check (method in ('cash', 'transfer', 'card', 'mixed', 'trade_in'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'sale_payments_currency_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_currency_check
      check (currency in ('ARS', 'USD'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'sale_payments_amount_positive_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_amount_positive_check
      check (amount > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'sale_payments_installments_positive_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_installments_positive_check
      check (installments is null or installments >= 1);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'sale_payments_surcharge_non_negative_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_surcharge_non_negative_check
      check (surcharge_pct is null or surcharge_pct >= 0);
  end if;
end $$;

create index if not exists idx_sale_payments_sale_id on public.sale_payments (sale_id);
create index if not exists idx_sale_payments_sale_id_created_at on public.sale_payments (sale_id, created_at desc);

-- idempotency keys (endpoint=user+route+key)
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

-- generic audit logs
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_json jsonb,
  after_json jsonb,
  meta_json jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_entity_type_entity_id_created_at
  on public.audit_logs (entity_type, entity_id, created_at desc);
create index if not exists idx_audit_logs_actor_created_at
  on public.audit_logs (actor_user_id, created_at desc);

create index if not exists idx_sale_items_sale_id_stock_item_id
  on public.sale_items (sale_id, stock_item_id);

create or replace function public.rpc_recompute_sale_receivable_v1(
  p_sale_id uuid,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
  v_paid_ars numeric := 0;
  v_balance_due_ars numeric := 0;
  v_receivable_status text := 'pending';
begin
  select id, total_ars, fx_rate_used, status
    into v_sale
  from public.sales
  where id = p_sale_id
  for update;

  if not found then
    raise exception using message = 'not_found', detail = 'sale_not_found';
  end if;

  select coalesce(sum(
    case
      when upper(coalesce(sp.currency, 'ARS')) = 'USD' then coalesce(sp.amount, 0) * coalesce(v_sale.fx_rate_used, 0)
      else coalesce(sp.amount, 0)
    end
  ), 0)
    into v_paid_ars
  from public.sale_payments sp
  where sp.sale_id = p_sale_id;

  v_balance_due_ars := greatest(coalesce(v_sale.total_ars, 0) - coalesce(v_paid_ars, 0), 0);

  if v_sale.status = 'cancelled' then
    v_receivable_status := 'paid';
  elsif v_balance_due_ars <= 0 then
    v_receivable_status := 'paid';
  elsif v_paid_ars > 0 then
    v_receivable_status := 'partial';
  else
    v_receivable_status := 'pending';
  end if;

  update public.sales
  set
    paid_ars = v_paid_ars,
    balance_due_ars = v_balance_due_ars,
    receivable_status = v_receivable_status,
    updated_at = now(),
    updated_by = coalesce(p_actor_user_id, updated_by)
  where id = p_sale_id;

  return jsonb_build_object(
    'sale_id', p_sale_id,
    'paid_ars', v_paid_ars,
    'balance_due_ars', v_balance_due_ars,
    'receivable_status', v_receivable_status
  );
end;
$$;

create or replace function public.rpc_register_sale_payment_v1(
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
  v_payment_id uuid;
  v_method text;
  v_currency text;
  v_amount numeric;
  v_card_brand text;
  v_installments integer;
  v_surcharge_pct numeric;
  v_note text;
  v_receivable jsonb;
begin
  select id, status
    into v_sale
  from public.sales
  where id = p_sale_id
  for update;

  if not found then
    raise exception using message = 'not_found', detail = 'sale_not_found';
  end if;

  if v_sale.status = 'cancelled' then
    raise exception using message = 'conflict', detail = 'sale_cancelled';
  end if;

  v_method := lower(coalesce(nullif(p_payload->>'method', ''), ''));
  if v_method not in ('cash', 'transfer', 'card', 'mixed', 'trade_in') then
    raise exception using message = 'validation_error', detail = format('invalid_payment_method:%s', v_method);
  end if;

  v_currency := upper(coalesce(nullif(p_payload->>'currency', ''), 'ARS'));
  if v_currency not in ('ARS', 'USD') then
    raise exception using message = 'validation_error', detail = format('invalid_currency:%s', v_currency);
  end if;

  v_amount := coalesce(nullif(p_payload->>'amount', '')::numeric, 0);
  if v_amount <= 0 then
    raise exception using message = 'validation_error', detail = 'payment_amount_must_be_gt_0';
  end if;

  v_card_brand := nullif(p_payload->>'card_brand', '');
  v_installments := nullif(p_payload->>'installments', '')::integer;
  if v_installments is not null and v_installments < 1 then
    raise exception using message = 'validation_error', detail = 'payment_installments_must_be_gte_1';
  end if;

  v_surcharge_pct := nullif(p_payload->>'surcharge_pct', '')::numeric;
  if v_surcharge_pct is not null and v_surcharge_pct < 0 then
    raise exception using message = 'validation_error', detail = 'payment_surcharge_pct_must_be_gte_0';
  end if;

  v_note := nullif(p_payload->>'note', '');

  insert into public.sale_payments (
    sale_id,
    method,
    currency,
    amount,
    card_brand,
    installments,
    surcharge_pct,
    note,
    created_by
  ) values (
    p_sale_id,
    v_method,
    v_currency,
    v_amount,
    v_card_brand,
    v_installments,
    v_surcharge_pct,
    v_note,
    p_user_id
  )
  returning id into v_payment_id;

  v_receivable := public.rpc_recompute_sale_receivable_v1(p_sale_id, p_user_id);

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_json,
    meta_json
  ) values (
    p_user_id,
    'payment_registered',
    'sale',
    p_sale_id,
    jsonb_build_object('payment_id', v_payment_id, 'amount', v_amount, 'currency', v_currency, 'method', v_method),
    jsonb_build_object('source', 'rpc_register_sale_payment_v1')
  );

  return jsonb_build_object(
    'sale_id', p_sale_id,
    'payment_id', v_payment_id,
    'paid_ars', coalesce((v_receivable->>'paid_ars')::numeric, 0),
    'balance_due_ars', coalesce((v_receivable->>'balance_due_ars')::numeric, 0),
    'receivable_status', coalesce(v_receivable->>'receivable_status', 'pending')
  );
end;
$$;

create or replace function public.rpc_settle_sale_v1(
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
  v_receivable jsonb;
  v_balance_due_ars numeric;
  v_method text;
  v_currency text;
  v_note text;
  v_result jsonb;
begin
  select id, status
    into v_sale
  from public.sales
  where id = p_sale_id
  for update;

  if not found then
    raise exception using message = 'not_found', detail = 'sale_not_found';
  end if;

  if v_sale.status = 'cancelled' then
    raise exception using message = 'conflict', detail = 'sale_cancelled';
  end if;

  v_receivable := public.rpc_recompute_sale_receivable_v1(p_sale_id, p_user_id);
  v_balance_due_ars := coalesce((v_receivable->>'balance_due_ars')::numeric, 0);

  if v_balance_due_ars <= 0 then
    return jsonb_build_object(
      'sale_id', p_sale_id,
      'payment_id', null,
      'paid_ars', coalesce((v_receivable->>'paid_ars')::numeric, 0),
      'balance_due_ars', 0,
      'receivable_status', 'paid'
    );
  end if;

  v_method := lower(coalesce(nullif(p_payload->>'method', ''), 'transfer'));
  if v_method not in ('cash', 'transfer', 'card', 'mixed', 'trade_in') then
    raise exception using message = 'validation_error', detail = format('invalid_payment_method:%s', v_method);
  end if;

  v_currency := upper(coalesce(nullif(p_payload->>'currency', ''), 'ARS'));
  if v_currency not in ('ARS', 'USD') then
    raise exception using message = 'validation_error', detail = format('invalid_currency:%s', v_currency);
  end if;

  v_note := coalesce(nullif(p_payload->>'note', ''), 'settle_sale');

  v_result := public.rpc_register_sale_payment_v1(
    p_sale_id,
    jsonb_build_object(
      'method', v_method,
      'currency', v_currency,
      'amount', v_balance_due_ars,
      'note', v_note
    ),
    p_user_id
  );

  return v_result;
end;
$$;

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
  v_details text;
  v_seller_id uuid;
  v_includes_cube_20w boolean;
  v_payments jsonb;
  v_payment_item jsonb;
  v_payment_item_method text;
  v_payment_item_currency text;
  v_payment_item_amount numeric;
  v_payment_item_card_brand text;
  v_payment_item_installments integer;
  v_payment_item_surcharge_pct numeric;
  v_payment_item_note text;
  v_payments_count integer := 0;
  v_receivable jsonb := '{}'::jsonb;
  v_stock record;
  v_warranty_days integer;
  v_customer_name text;
  v_customer_phone text;
  v_stock_ids uuid[] := array[]::uuid[];
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

  begin
    v_seller_id := coalesce(nullif(p_payload->>'seller_id', '')::uuid, p_user_id);
  exception
    when invalid_text_representation then
      raise exception using message = 'validation_error', detail = 'seller_id_invalid';
  end;

  if not exists (select 1 from public.profiles where id = v_seller_id) then
    raise exception using message = 'not_found', detail = 'seller_not_found';
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
  v_details := nullif(p_payload->>'details', '');
  v_includes_cube_20w := coalesce((p_payload->>'includes_cube_20w')::boolean, false);

  insert into public.sales (
    sale_date,
    customer_id,
    seller_id,
    payment_method,
    card_brand,
    installments,
    surcharge_pct,
    deposit_ars,
    total_ars,
    paid_ars,
    receivable_status,
    created_by,
    status,
    updated_at,
    updated_by,
    currency,
    fx_rate_used,
    total_usd,
    balance_due_ars,
    details,
    notes,
    includes_cube_20w
  ) values (
    v_sale_date,
    v_customer_id,
    v_seller_id,
    v_payment_method,
    v_card_brand,
    v_installments,
    v_surcharge_pct,
    v_deposit_ars,
    v_server_total,
    0,
    'pending',
    p_user_id,
    'completed',
    now(),
    p_user_id,
    v_currency,
    v_fx_rate_used,
    v_total_usd,
    v_balance_due_ars,
    v_details,
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
      raise exception using message = 'stock_conflict', detail = format('%s:%s', v_stock_id, v_stock.status);
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
      set status = 'sold',
          sale_id = v_sale_id,
          sold_at = coalesce(v_sale_date, now())
    where id = v_stock_id;

    v_stock_ids := array_append(v_stock_ids, v_stock_id);

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

  v_payments := p_payload->'payments';
  if v_payments is null then
    v_payment_item_amount := case
      when coalesce(v_deposit_ars, 0) > 0 and coalesce(v_deposit_ars, 0) < v_server_total then v_deposit_ars
      else v_server_total
    end;

    insert into public.sale_payments (
      sale_id,
      method,
      currency,
      amount,
      card_brand,
      installments,
      surcharge_pct,
      note,
      created_by
    ) values (
      v_sale_id,
      lower(v_payment_method::text),
      v_currency,
      v_payment_item_amount,
      v_card_brand_text,
      v_installments,
      v_surcharge_pct,
      null,
      p_user_id
    );
    v_payments_count := v_payments_count + 1;
  else
    if jsonb_typeof(v_payments) <> 'array' or jsonb_array_length(v_payments) = 0 then
      raise exception using message = 'validation_error', detail = 'payments_required';
    end if;

    for v_payment_item in select value from jsonb_array_elements(v_payments)
    loop
      v_payment_item_method := lower(coalesce(nullif(v_payment_item->>'method', ''), ''));
      if v_payment_item_method not in ('cash', 'transfer', 'card', 'mixed', 'trade_in') then
        raise exception using message = 'validation_error', detail = format('invalid_payment_method:%s', v_payment_item_method);
      end if;

      v_payment_item_currency := upper(coalesce(nullif(v_payment_item->>'currency', ''), v_currency, 'ARS'));
      if v_payment_item_currency not in ('ARS', 'USD') then
        raise exception using message = 'validation_error', detail = format('invalid_currency:%s', v_payment_item_currency);
      end if;

      v_payment_item_amount := coalesce(nullif(v_payment_item->>'amount', '')::numeric, 0);
      if v_payment_item_amount <= 0 then
        raise exception using message = 'validation_error', detail = 'payment_amount_must_be_gt_0';
      end if;

      v_payment_item_card_brand := nullif(v_payment_item->>'card_brand', '');
      v_payment_item_installments := nullif(v_payment_item->>'installments', '')::integer;
      if v_payment_item_installments is not null and v_payment_item_installments < 1 then
        raise exception using message = 'validation_error', detail = 'payment_installments_must_be_gte_1';
      end if;

      v_payment_item_surcharge_pct := nullif(v_payment_item->>'surcharge_pct', '')::numeric;
      if v_payment_item_surcharge_pct is not null and v_payment_item_surcharge_pct < 0 then
        raise exception using message = 'validation_error', detail = 'payment_surcharge_pct_must_be_gte_0';
      end if;

      v_payment_item_note := nullif(v_payment_item->>'note', '');

      insert into public.sale_payments (
        sale_id,
        method,
        currency,
        amount,
        card_brand,
        installments,
        surcharge_pct,
        note,
        created_by
      ) values (
        v_sale_id,
        v_payment_item_method,
        v_payment_item_currency,
        v_payment_item_amount,
        v_payment_item_card_brand,
        v_payment_item_installments,
        v_payment_item_surcharge_pct,
        v_payment_item_note,
        p_user_id
      );

      v_payments_count := v_payments_count + 1;
    end loop;
  end if;

  v_receivable := public.rpc_recompute_sale_receivable_v1(v_sale_id, p_user_id);

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

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_json,
    meta_json
  ) values (
    p_user_id,
    'sale_created',
    'sale',
    v_sale_id,
    jsonb_build_object(
      'total_ars', v_server_total,
      'customer_id', v_customer_id,
      'seller_id', v_seller_id
    ),
    jsonb_build_object('source', 'rpc_create_sale_v2')
  );

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    meta_json
  ) values (
    p_user_id,
    'stock_state_changed',
    'sale',
    v_sale_id,
    jsonb_build_object(
      'stock_item_ids', to_jsonb(v_stock_ids),
      'new_status', 'sold'
    )
  );

  if v_payments_count > 0 then
    insert into public.audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      meta_json
    ) values (
      p_user_id,
      'payment_registered',
      'sale',
      v_sale_id,
      jsonb_build_object('payments_count', v_payments_count, 'source', 'checkout')
    );
  end if;

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    meta_json
  ) values (
    p_user_id,
    'warranty_status_changed',
    'sale',
    v_sale_id,
    jsonb_build_object('event', 'created_from_sale', 'warranties_count', coalesce(array_length(v_stock_ids, 1), 0))
  );

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'trade_in_id', v_trade_in_id,
    'customer_id', v_customer_id,
    'seller_id', v_seller_id,
    'total_ars', v_server_total,
    'server_total_ars', v_server_total,
    'paid_ars', coalesce((v_receivable->>'paid_ars')::numeric, 0),
    'receivable_status', coalesce(v_receivable->>'receivable_status', 'pending'),
    'currency', v_currency,
    'fx_rate_used', v_fx_rate_used,
    'total_usd', v_total_usd,
    'balance_due_ars', coalesce((v_receivable->>'balance_due_ars')::numeric, v_balance_due_ars),
    'details', v_details,
    'notes', v_notes,
    'includes_cube_20w', v_includes_cube_20w
  );
end;
$$;

create or replace function public.rpc_cancel_sale_v2(
  p_sale_id uuid,
  p_reason text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
  v_stock_ids uuid[];
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
    return jsonb_build_object(
      'sale_id', p_sale_id,
      'status', 'cancelled',
      'already_cancelled', true
    );
  end if;

  select coalesce(array_agg(stock_item_id), array[]::uuid[])
    into v_stock_ids
  from public.sale_items
  where sale_id = p_sale_id;

  update public.stock_items
  set status = 'available',
      sale_id = null,
      sold_at = null
  where id = any(v_stock_ids);

  delete from public.warranties
  where sale_id = p_sale_id;

  update public.sales
  set
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = p_user_id,
    cancel_reason = p_reason,
    balance_due_ars = 0,
    receivable_status = 'paid',
    updated_at = now(),
    updated_by = p_user_id
  where id = p_sale_id;

  insert into public.sale_audit_logs (sale_id, action, actor_user_id, reason)
  values (p_sale_id, 'cancelled', p_user_id, p_reason);

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    meta_json
  ) values (
    p_user_id,
    'stock_state_changed',
    'sale',
    p_sale_id,
    jsonb_build_object('stock_item_ids', to_jsonb(v_stock_ids), 'new_status', 'available', 'reason', p_reason)
  );

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    meta_json
  ) values (
    p_user_id,
    'warranty_status_changed',
    'sale',
    p_sale_id,
    jsonb_build_object('event', 'cancelled', 'reason', p_reason)
  );

  return jsonb_build_object(
    'sale_id', p_sale_id,
    'status', 'cancelled'
  );
end;
$$;

commit;
