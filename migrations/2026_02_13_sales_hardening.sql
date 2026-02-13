begin;

create extension if not exists pgcrypto;

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

create index if not exists idx_sales_sale_date on public.sales (sale_date);
create index if not exists idx_sales_status on public.sales (status);

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
  v_payment_method text;
  v_card_brand text;
  v_installments integer;
  v_surcharge_pct numeric;
  v_deposit_ars numeric;
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
  v_payment_method := coalesce(nullif(p_payload->>'payment_method', ''), nullif(v_payment->>'method', ''), 'cash');
  v_card_brand := coalesce(nullif(p_payload->>'card_brand', ''), nullif(v_payment->>'card_brand', ''));
  v_installments := coalesce(nullif(p_payload->>'installments', '')::integer, nullif(v_payment->>'installments', '')::integer);
  v_surcharge_pct := coalesce(nullif(p_payload->>'surcharge_pct', '')::numeric, nullif(v_payment->>'surcharge_pct', '')::numeric);
  v_deposit_ars := coalesce(nullif(p_payload->>'deposit_ars', '')::numeric, nullif(v_payment->>'deposit_ars', '')::numeric);

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
    updated_by
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
    p_user_id
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
      status
    ) values (
      v_sale_id,
      coalesce(v_trade_in->'device', '{}'::jsonb),
      coalesce((v_trade_in->>'trade_value_usd')::numeric, 0),
      coalesce((v_trade_in->>'fx_rate_used')::numeric, 0),
      'valued'
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
    'server_total_ars', v_server_total
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
  v_payment_method text;
  v_card_brand text;
  v_installments integer;
  v_surcharge_pct numeric;
  v_deposit_ars numeric;
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
  v_payment_method := coalesce(nullif(p_payload->>'payment_method', ''), nullif(v_payment->>'method', ''), v_sale.payment_method, 'cash');
  v_card_brand := coalesce(nullif(p_payload->>'card_brand', ''), nullif(v_payment->>'card_brand', ''), v_sale.card_brand);
  v_installments := coalesce(nullif(p_payload->>'installments', '')::integer, nullif(v_payment->>'installments', '')::integer, v_sale.installments);
  v_surcharge_pct := coalesce(nullif(p_payload->>'surcharge_pct', '')::numeric, nullif(v_payment->>'surcharge_pct', '')::numeric, v_sale.surcharge_pct);
  v_deposit_ars := coalesce(nullif(p_payload->>'deposit_ars', '')::numeric, nullif(v_payment->>'deposit_ars', '')::numeric, v_sale.deposit_ars);

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

  v_input_total := nullif(p_payload->>'total_ars', '')::numeric;
  if v_input_total is not null and abs(v_input_total - v_total_ars) > 0.01 then
    raise exception using message = 'total_mismatch', detail = format('input=%s server=%s', v_input_total, v_total_ars);
  end if;

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
    updated_by = p_user_id
  where id = p_sale_id;

  insert into public.sale_audit_logs (sale_id, action, actor_user_id, payload)
  values (p_sale_id, 'updated', p_user_id, p_payload);

  return jsonb_build_object(
    'sale_id', p_sale_id,
    'customer_id', v_customer_id,
    'total_ars', v_total_ars,
    'server_total_ars', v_total_ars,
    'status', 'completed'
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

  update public.stock_items
  set status = 'available'
  where id in (
    select stock_item_id
    from public.sale_items
    where sale_id = p_sale_id
  );

  delete from public.warranties
  where sale_id = p_sale_id;

  update public.sales
  set
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = p_user_id,
    cancel_reason = p_reason,
    updated_at = now(),
    updated_by = p_user_id
  where id = p_sale_id;

  insert into public.sale_audit_logs (sale_id, action, actor_user_id, reason)
  values (p_sale_id, 'cancelled', p_user_id, p_reason);

  return jsonb_build_object(
    'sale_id', p_sale_id,
    'status', 'cancelled'
  );
end;
$$;

commit;
