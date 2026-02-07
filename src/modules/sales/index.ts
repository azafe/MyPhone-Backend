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

router.post('/', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = saleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid sale payload', details: parsed.error.flatten() }
    });
  }

  const payload = parsed.data;

  const { data, error } = await supabaseAdmin.rpc('rpc_create_sale', { payload });

  if (error) {
    return res.status(400).json({ error: { code: 'sale_create_failed', message: 'RPC failed', details: error.message } });
  }

  return res.status(201).json({
    sale_id: data?.sale_id ?? data?.id ?? null,
    trade_in_id: data?.trade_in_id ?? null,
    customer_id: data?.customer_id ?? null
  });
});

export const salesRouter = router;
