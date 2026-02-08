import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const conditionEnum = z.enum(['new', 'like_new', 'used', 'outlet']);

const createSchema = z
  .object({
    brand: z.string().min(1),
    model: z.string().min(1),
    condition: conditionEnum,
    category: z.enum(['used_premium', 'outlet']),
    sale_price_ars: z.number().min(0),
    sale_price_usd: z.number().min(0).nullable().optional(),
    purchase_usd: z.number().min(0).nullable().optional(),
    fx_rate_used: z.number().min(0).nullable().optional(),
    purchase_ars: z.number().min(0).nullable().optional(),
    warranty_days: z.number().int().positive().nullable().optional(),
    battery_pct: z.number().int().min(0).max(100).nullable().optional(),
    storage_gb: z.number().int().positive().nullable().optional(),
    color: z.string().nullable().optional(),
    color_other: z.string().nullable().optional(),
    imei: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    status: z.enum(['available', 'reserved', 'sold']).optional()
  })
  .refine(
    (data) =>
      data.purchase_ars != null ||
      (data.purchase_usd != null && data.fx_rate_used != null),
    { message: 'purchase_ars or (purchase_usd + fx_rate_used) required' }
  );

router.post('/', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid stock item payload', details: parsed.error.flatten() }
    });
  }

  const payload = parsed.data;
  const purchase_ars =
    payload.purchase_ars ??
    Number(payload.purchase_usd) * Number(payload.fx_rate_used);

  const insertPayload = {
    brand: payload.brand,
    model: payload.model,
    condition: payload.condition,
    category: payload.category,
    sale_price_ars: payload.sale_price_ars,
    sale_price_usd: payload.sale_price_usd ?? null,
    purchase_usd: payload.purchase_usd ?? null,
    fx_rate_used: payload.fx_rate_used ?? null,
    purchase_ars,
    warranty_days: payload.warranty_days ?? 90,
    battery_pct: payload.battery_pct ?? null,
    storage_gb: payload.storage_gb ?? null,
    color: payload.color ?? null,
    color_other: payload.color_other ?? null,
    imei: payload.imei ?? null,
    notes: payload.notes ?? null,
    status: payload.status ?? 'available',
    trade_in_id: null
  };

  const { data, error } = await supabaseAdmin
    .from('stock_items')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error || !data) {
    return res.status(400).json({
      error: { code: 'stock_create_failed', message: 'Insert failed', details: error?.message }
    });
  }

  return res.status(201).json({ stock_item_id: data.id });
});

export const stockItemsRouter = router;
