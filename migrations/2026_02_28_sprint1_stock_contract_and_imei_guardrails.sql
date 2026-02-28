begin;

-- Normalize IMEI values before applying uniqueness.
update public.stock_items
set imei = nullif(btrim(imei), '')
where imei is not null;

do $$
declare
  v_duplicate_count integer;
begin
  select count(*)
    into v_duplicate_count
  from (
    select lower(imei) as imei_key
    from public.stock_items
    where imei is not null
    group by lower(imei)
    having count(*) > 1
  ) duplicates;

  if v_duplicate_count > 0 then
    raise exception using
      message = 'validation_error',
      detail = 'duplicate_imei_values_exist',
      hint = 'Resolve duplicate IMEI values in stock_items before running this migration.';
  end if;
end;
$$;

create unique index if not exists idx_stock_items_imei_unique_global
  on public.stock_items (lower(imei))
  where imei is not null;

create or replace function public.rpc_cancel_sale_v2(
  p_sale_id uuid,
  p_reason text,
  p_user_id uuid,
  p_restock_status text default 'available',
  p_restock_category text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
  v_stock_ids uuid[];
  v_restock_status text;
  v_restock_category text;
begin
  v_restock_status := coalesce(nullif(p_restock_status, ''), 'available');
  v_restock_category := nullif(p_restock_category, '');

  if v_restock_status not in ('available', 'reserved', 'drawer', 'service_tech') then
    raise exception using message = 'validation_error', detail = 'invalid_restock_status';
  end if;

  if v_restock_category is not null and v_restock_category not in ('used_premium', 'outlet', 'new') then
    raise exception using message = 'validation_error', detail = 'invalid_restock_category';
  end if;

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
  set status = v_restock_status,
      category = case
        when v_restock_status = 'available' and v_restock_category is not null then v_restock_category
        else category
      end,
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
    jsonb_build_object(
      'stock_item_ids', to_jsonb(v_stock_ids),
      'new_status', v_restock_status,
      'new_category', v_restock_category,
      'reason', p_reason
    )
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
    'status', 'cancelled',
    'restock_status', v_restock_status,
    'restock_category', v_restock_category
  );
end;
$$;

commit;
