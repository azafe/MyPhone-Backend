import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const tradeInCreateSchema = z.object({
  device: z.object({
    brand: z.string().min(1),
    model: z.string().min(1),
    storage_gb: z.number().int().positive().optional(),
    color: z.string().optional(),
    condition: z.string().optional(),
    imei: z.string().optional()
  }),
  trade_value_usd: z.number().min(0),
  fx_rate_used: z.number().min(0),
  status: z.enum(['pending', 'valued']).optional(),
  notes: z.string().optional()
});

const tradeInPatchSchema = z.object({
  trade_value_usd: z.number().min(0).optional(),
  fx_rate_used: z.number().min(0).optional(),
  status: z.enum(['pending', 'valued', 'added_to_stock']).optional(),
  notes: z.string().optional()
});

const convertSchema = z.object({
  category: z.enum(['used_premium', 'outlet']),
  sale_price_ars: z.number().min(0),
  sale_price_usd: z.number().min(0).optional(),
  warranty_days: z.number().int().positive().optional(),
  warranty_days_default: z.number().int().positive().optional(),
  battery_pct: z.number().int().min(0).max(100).optional(),
  storage_gb: z.number().int().positive().optional(),
  color: z.string().optional(),
  color_other: z.string().optional(),
  imei: z.string().optional(),
  notes: z.string().optional()
});

router.post('/', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = tradeInCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid trade-in payload', details: parsed.error.flatten() } });
  }

  const insertPayload = {
    ...parsed.data,
    status: parsed.data.status ?? 'pending',
    sale_id: null
  };

  const { data, error } = await supabaseAdmin
    .from('trade_ins')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error) {
    return res.status(400).json({ error: { code: 'trade_in_create_failed', message: 'Insert failed', details: error.message } });
  }

  return res.status(201).json({ trade_in_id: data.id });
});

router.patch('/:id', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = tradeInPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid trade-in patch', details: parsed.error.flatten() } });
  }

  const { data, error } = await supabaseAdmin
    .from('trade_ins')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    return res.status(400).json({ error: { code: 'trade_in_update_failed', message: 'Update failed', details: error?.message } });
  }

  return res.json({ trade_in_id: data.id });
});

router.post('/:id/convert-to-stock', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = convertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid convert payload', details: parsed.error.flatten() } });
  }

  const { data: tradeIn, error: tradeInError } = await supabaseAdmin
    .from('trade_ins')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (tradeInError || !tradeIn) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Trade-in not found', details: tradeInError?.message } });
  }

  const purchase_ars = Number(tradeIn.trade_value_usd) * Number(tradeIn.fx_rate_used);
  const stockItemPayload = {
    category: parsed.data.category,
    sale_price_ars: parsed.data.sale_price_ars,
    sale_price_usd: parsed.data.sale_price_usd ?? null,
    warranty_days: parsed.data.warranty_days ?? parsed.data.warranty_days_default ?? 90,
    battery_pct: parsed.data.battery_pct ?? null,
    storage_gb: parsed.data.storage_gb ?? tradeIn.device?.storage_gb ?? null,
    color: parsed.data.color ?? tradeIn.device?.color ?? null,
    color_other: parsed.data.color_other ?? null,
    imei: parsed.data.imei ?? tradeIn.device?.imei ?? null,
    notes: parsed.data.notes ?? null,
    purchase_usd: tradeIn.trade_value_usd,
    fx_rate_used: tradeIn.fx_rate_used,
    purchase_ars,
    status: 'available',
    trade_in_id: tradeIn.id
  };

  const { data: stockItem, error: stockError } = await supabaseAdmin
    .from('stock_items')
    .insert(stockItemPayload)
    .select('id')
    .single();

  if (stockError || !stockItem) {
    return res.status(400).json({ error: { code: 'stock_create_failed', message: 'Stock insert failed', details: stockError?.message } });
  }

  const { error: updateError } = await supabaseAdmin
    .from('trade_ins')
    .update({ status: 'added_to_stock' })
    .eq('id', tradeIn.id);

  if (updateError) {
    return res.status(400).json({ error: { code: 'trade_in_update_failed', message: 'Trade-in status update failed', details: updateError.message } });
  }

  return res.status(201).json({ stock_item_id: stockItem.id });
});

export const tradeInsRouter = router;
