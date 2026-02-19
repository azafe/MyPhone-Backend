begin;

alter table if exists public.sales
  add column if not exists seller_id uuid,
  add column if not exists details text;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sales'
      and column_name = 'created_by'
  ) then
    execute '
      update public.sales
      set seller_id = created_by
      where seller_id is null
        and created_by is not null
    ';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sales_seller_id_fk'
  ) then
    alter table public.sales
      add constraint sales_seller_id_fk
      foreign key (seller_id)
      references public.profiles(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_sales_seller_id on public.sales (seller_id);

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
  created_at timestamptz not null default now()
);

alter table if exists public.sale_payments
  add column if not exists method text,
  add column if not exists currency text,
  add column if not exists amount numeric,
  add column if not exists card_brand text,
  add column if not exists installments integer,
  add column if not exists surcharge_pct numeric,
  add column if not exists note text,
  add column if not exists created_at timestamptz default now();

update public.sale_payments
set currency = 'ARS'
where currency is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sale_payments_method_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_method_check
      check (method in ('cash', 'transfer', 'card', 'mixed', 'trade_in'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'sale_payments_currency_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_currency_check
      check (currency in ('ARS', 'USD'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'sale_payments_amount_positive_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_amount_positive_check
      check (amount > 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'sale_payments_installments_positive_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_installments_positive_check
      check (installments is null or installments >= 1);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'sale_payments_surcharge_non_negative_check'
  ) then
    alter table public.sale_payments
      add constraint sale_payments_surcharge_non_negative_check
      check (surcharge_pct is null or surcharge_pct >= 0);
  end if;
end $$;

alter table if exists public.sale_payments
  alter column currency set default 'ARS',
  alter column currency set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

create index if not exists idx_sale_payments_sale_id on public.sale_payments (sale_id);
create index if not exists idx_sale_payments_created_at on public.sale_payments (created_at desc);

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

  v_payments := p_payload->'payments';
  if v_payments is null then
    insert into public.sale_payments (
      sale_id,
      method,
      currency,
      amount,
      card_brand,
      installments,
      surcharge_pct,
      note
    ) values (
      v_sale_id,
      lower(v_payment_method::text),
      v_currency,
      v_server_total,
      v_card_brand_text,
      v_installments,
      v_surcharge_pct,
      null
    );
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
        note
      ) values (
        v_sale_id,
        v_payment_item_method,
        v_payment_item_currency,
        v_payment_item_amount,
        v_payment_item_card_brand,
        v_payment_item_installments,
        v_payment_item_surcharge_pct,
        v_payment_item_note
      );
    end loop;
  end if;

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
    'seller_id', v_seller_id,
    'total_ars', v_server_total,
    'server_total_ars', v_server_total,
    'currency', v_currency,
    'fx_rate_used', v_fx_rate_used,
    'total_usd', v_total_usd,
    'balance_due_ars', v_balance_due_ars,
    'details', v_details,
    'notes', v_notes,
    'includes_cube_20w', v_includes_cube_20w
  );
end;
$$;

commit;
