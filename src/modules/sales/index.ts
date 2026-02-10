import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const saleSchema = z.object({
  sale_date: z.string().datetime(),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().min(6)
  }),
  payment: z.object({
    method: z.string().min(1),
    card_brand: z.string().optional(),
    installments: z.number().int().positive().optional(),
    surcharge_pct: z.number().min(0).optional(),
    deposit_ars: z.number().min(0).optional(),
    total_ars: z.number().min(0)
  }),
  items: z.array(
    z.object({
      stock_item_id: z.string().min(1),
      sale_price_ars: z.number().min(0)
    })
  ).min(1),
  trade_in: z.object({
    enabled: z.boolean(),
    device: z.object({
      brand: z.string().min(1),
      model: z.string().min(1),
      storage_gb: z.number().int().positive().optional(),
      color: z.string().optional(),
      condition: z.string().optional(),
      imei: z.string().optional()
    }),
    trade_value_usd: z.number().min(0),
    fx_rate_used: z.number().min(0)
  }).optional()
});

router.get('/', requireRole('admin', 'seller'), async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('sales')
    .select('*, customers(name, phone), sale_items(stock_item_id, stock_items(model, imei))')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(400).json({
      error: { code: 'sales_fetch_failed', message: 'Sales fetch failed', details: error.message }
    });
  }

  const rows = (data ?? []).flatMap((sale) => {
    const items = sale.sale_items ?? [];
    const customerName = sale.customers?.name ?? null;
    const customerPhone = sale.customers?.phone ?? null;
    if (items.length === 0) {
      return [
        {
          ...sale,
          stock_item_id: null,
          stock_model: null,
          stock_imei: null,
          customer_name: customerName,
          customer_phone: customerPhone
        }
      ];
    }

    return items.map((item: { stock_item_id: string; stock_items?: { model: string | null; imei: string | null } }) => ({
      ...sale,
      stock_item_id: item.stock_item_id,
      stock_model: item.stock_items?.model ?? null,
      stock_imei: item.stock_items?.imei ?? null,
      customer_name: customerName,
      customer_phone: customerPhone
    }));
  });

  return res.json({ sales: rows });
});

router.post('/', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = saleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid sale payload', details: parsed.error.flatten() }
    });
  }

  const payload = parsed.data;

  // 1) Upsert customer by phone
  const { data: existingCustomer, error: existingCustomerError } = await supabaseAdmin
    .from('customers')
    .select('id')
    .eq('phone', payload.customer.phone)
    .maybeSingle();

  if (existingCustomerError) {
    return res.status(400).json({
      error: { code: 'customer_lookup_failed', message: 'Customer lookup failed', details: existingCustomerError.message }
    });
  }

  let customerId = existingCustomer?.id;
  if (!customerId) {
    const { data: newCustomer, error: newCustomerError } = await supabaseAdmin
      .from('customers')
      .insert({ name: payload.customer.name, phone: payload.customer.phone })
      .select('id')
      .single();

    if (newCustomerError || !newCustomer) {
      return res.status(400).json({
        error: { code: 'customer_create_failed', message: 'Customer create failed', details: newCustomerError?.message }
      });
    }
    customerId = newCustomer.id;
  } else {
    // Keep name fresh
    await supabaseAdmin.from('customers').update({ name: payload.customer.name }).eq('id', customerId);
  }

  // 2) Validate stock items
  const stockIds = payload.items.map((item) => item.stock_item_id);
  const { data: stockItems, error: stockError } = await supabaseAdmin
    .from('stock_items')
    .select('id, status, warranty_days, warranty_days_default')
    .in('id', stockIds);

  if (stockError) {
    return res.status(400).json({
      error: { code: 'stock_lookup_failed', message: 'Stock lookup failed', details: stockError.message }
    });
  }

  const stockById = new Map((stockItems ?? []).map((item) => [item.id, item]));
  const missing = stockIds.filter((id) => !stockById.has(id));
  if (missing.length > 0) {
    return res.status(400).json({
      error: { code: 'stock_missing', message: 'Some stock items do not exist', details: missing }
    });
  }

  const unavailable = (stockItems ?? []).filter((item) => item.status !== 'available');
  if (unavailable.length > 0) {
    return res.status(400).json({
      error: {
        code: 'stock_unavailable',
        message: 'Some stock items are not available',
        details: unavailable.map((item) => ({ id: item.id, status: item.status }))
      }
    });
  }

  // 3) Create sale
  const { data: sale, error: saleError } = await supabaseAdmin
    .from('sales')
    .insert({
      sale_date: payload.sale_date,
      customer_id: customerId,
      payment_method: payload.payment.method,
      card_brand: payload.payment.card_brand ?? null,
      installments: payload.payment.installments ?? null,
      surcharge_pct: payload.payment.surcharge_pct ?? null,
      deposit_ars: payload.payment.deposit_ars ?? null,
      total_ars: payload.payment.total_ars
    })
    .select('id')
    .single();

  if (saleError || !sale) {
    return res.status(400).json({
      error: { code: 'sale_create_failed', message: 'Sale create failed', details: saleError?.message }
    });
  }

  const saleId = sale.id;

  // 4) Create sale items
  const saleItemsPayload = payload.items.map((item) => ({
    sale_id: saleId,
    stock_item_id: item.stock_item_id,
    sale_price_ars: item.sale_price_ars
  }));

  const { error: saleItemsError } = await supabaseAdmin.from('sale_items').insert(saleItemsPayload);
  if (saleItemsError) {
    return res.status(400).json({
      error: { code: 'sale_items_create_failed', message: 'Sale items create failed', details: saleItemsError.message }
    });
  }

  // 5) Mark stock as sold
  const { error: stockUpdateError } = await supabaseAdmin
    .from('stock_items')
    .update({ status: 'sold' })
    .in('id', stockIds);

  if (stockUpdateError) {
    return res.status(400).json({
      error: { code: 'stock_update_failed', message: 'Stock status update failed', details: stockUpdateError.message }
    });
  }

  // 6) Create warranties (best effort if table exists)
  const warrantyRows = (stockItems ?? []).map((item) => {
    const warrantyDays = Number(item.warranty_days ?? item.warranty_days_default ?? 90);
    const start = new Date(payload.sale_date);
    const end = new Date(start);
    end.setDate(end.getDate() + warrantyDays);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    return {
      sale_id: saleId,
      stock_item_id: item.id,
      customer_id: customerId,
      start_date: startIso,
      end_date: endIso,
      warranty_days: warrantyDays,
      warranty_start: startIso,
      warranty_end: endIso
    };
  });

  const { error: warrantyError } = await supabaseAdmin.from('warranties').insert(warrantyRows);
  if (warrantyError) {
    return res.status(400).json({
      error: { code: 'warranty_create_failed', message: 'Warranty create failed', details: warrantyError.message }
    });
  }

  // 7) Trade-in (optional)
  let tradeInId: string | null = null;
  if (payload.trade_in?.enabled) {
    const { data: tradeIn, error: tradeInError } = await supabaseAdmin
      .from('trade_ins')
      .insert({
        sale_id: saleId,
        device: payload.trade_in.device,
        trade_value_usd: payload.trade_in.trade_value_usd,
        fx_rate_used: payload.trade_in.fx_rate_used,
        status: 'valued'
      })
      .select('id')
      .single();

    if (tradeInError || !tradeIn) {
      return res.status(400).json({
        error: { code: 'trade_in_create_failed', message: 'Trade-in create failed', details: tradeInError?.message }
      });
    }
    tradeInId = tradeIn.id;
  }

  return res.status(201).json({
    sale_id: saleId,
    trade_in_id: tradeInId,
    customer_id: customerId
  });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const saleId = req.params.id;

  // Load related sale items to restore stock
  const { data: saleItems, error: saleItemsError } = await supabaseAdmin
    .from('sale_items')
    .select('stock_item_id')
    .eq('sale_id', saleId);

  if (saleItemsError) {
    return res.status(400).json({
      error: { code: 'sale_items_fetch_failed', message: 'Sale items fetch failed', details: saleItemsError.message }
    });
  }

  const stockIds = (saleItems ?? []).map((item) => item.stock_item_id).filter(Boolean);

  const { error: warrantiesError } = await supabaseAdmin.from('warranties').delete().eq('sale_id', saleId);
  if (warrantiesError) {
    return res.status(400).json({
      error: { code: 'warranties_delete_failed', message: 'Warranties delete failed', details: warrantiesError.message }
    });
  }

  const { error: tradeInsError } = await supabaseAdmin.from('trade_ins').delete().eq('sale_id', saleId);
  if (tradeInsError) {
    return res.status(400).json({
      error: { code: 'trade_ins_delete_failed', message: 'Trade-ins delete failed', details: tradeInsError.message }
    });
  }

  const { error: saleItemsDeleteError } = await supabaseAdmin.from('sale_items').delete().eq('sale_id', saleId);
  if (saleItemsDeleteError) {
    return res.status(400).json({
      error: { code: 'sale_items_delete_failed', message: 'Sale items delete failed', details: saleItemsDeleteError.message }
    });
  }

  const { error: saleDeleteError, count } = await supabaseAdmin
    .from('sales')
    .delete({ count: 'exact' })
    .eq('id', saleId);

  if (saleDeleteError) {
    return res.status(400).json({
      error: { code: 'sale_delete_failed', message: 'Sale delete failed', details: saleDeleteError.message }
    });
  }

  if (!count) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Sale not found' } });
  }

  if (stockIds.length > 0) {
    const { error: stockRestoreError } = await supabaseAdmin
      .from('stock_items')
      .update({ status: 'available' })
      .in('id', stockIds);

    if (stockRestoreError) {
      return res.status(400).json({
        error: { code: 'stock_restore_failed', message: 'Stock restore failed', details: stockRestoreError.message }
      });
    }
  }

  return res.status(204).send();
});

export const salesRouter = router;
