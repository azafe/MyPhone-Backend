import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

function logValidationError(scope: string, details: unknown): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    level: 'warn',
    event: 'validation_error',
    scope,
    details,
    timestamp: new Date().toISOString()
  }));
}

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
  sale_ref: z.string().min(1).optional(),
  customer_name: z.string().min(1).optional(),
  customer_phone: z.string().min(6).optional(),
  notes: z.string().optional()
});

const tradeInPatchSchema = z.object({
  trade_value_usd: z.number().min(0).optional(),
  fx_rate_used: z.number().min(0).optional(),
  status: z.enum(['pending', 'valued', 'added_to_stock']).optional(),
  sale_ref: z.string().min(1).optional(),
  customer_name: z.string().min(1).optional(),
  customer_phone: z.string().min(6).optional(),
  notes: z.string().optional()
});

const convertSchema = z.object({
  category: z.enum(['used_premium', 'outlet']),
  sale_price_ars: z.number().min(0),
  sale_price_usd: z.number().min(0).nullable().optional(),
  warranty_days: z.number().int().positive().nullable().optional(),
  warranty_days_default: z.number().int().positive().nullable().optional(),
  battery_pct: z.number().int().min(0).max(100).nullable().optional(),
  storage_gb: z.number().int().positive().nullable().optional(),
  color: z.string().nullable().optional(),
  color_other: z.string().nullable().optional(),
  imei: z.string().nullable().optional(),
  notes: z.string().nullable().optional()
});

router.post('/', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = tradeInCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    logValidationError('trade-ins.create', parsed.error.flatten());
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
    logValidationError('trade-ins.patch', parsed.error.flatten());
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
    logValidationError('trade-ins.convert', parsed.error.flatten());
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
  const storage_gb =
    parsed.data.storage_gb !== undefined
      ? parsed.data.storage_gb
      : tradeIn.device?.storage_gb ?? null;
  const color =
    parsed.data.color !== undefined
      ? parsed.data.color
      : tradeIn.device?.color ?? null;
  const imei =
    parsed.data.imei !== undefined
      ? parsed.data.imei
      : tradeIn.device?.imei ?? null;

  const allowedConditions = new Set(['new', 'like_new', 'used', 'outlet']);
  const conditionRaw = tradeIn.device?.condition ?? null;
  const condition = conditionRaw && allowedConditions.has(conditionRaw) ? conditionRaw : 'used';

  const stockItemPayload = {
    brand: tradeIn.device?.brand ?? null,
    model: tradeIn.device?.model ?? null,
    condition,
    category: parsed.data.category,
    sale_price_ars: parsed.data.sale_price_ars,
    sale_price_usd: parsed.data.sale_price_usd ?? null,
    warranty_days: parsed.data.warranty_days ?? parsed.data.warranty_days_default ?? 90,
    battery_pct: parsed.data.battery_pct ?? null,
    storage_gb,
    color,
    color_other: parsed.data.color_other ?? null,
    imei,
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
