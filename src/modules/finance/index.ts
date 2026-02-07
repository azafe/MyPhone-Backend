import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

router.get('/summary', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid date range', details: parsed.error.flatten() } });
  }

  const { from, to } = parsed.data;

  const { data: sales, error: salesError } = await supabaseAdmin
    .from('sales')
    .select('id, sale_date, total_ars, payment_method')
    .gte('sale_date', `${from}T00:00:00Z`)
    .lte('sale_date', `${to}T23:59:59Z`);

  if (salesError) {
    return res.status(400).json({ error: { code: 'finance_fetch_failed', message: 'Sales query failed', details: salesError.message } });
  }

  const { data: saleItems, error: itemsError } = await supabaseAdmin
    .from('sale_items')
    .select('sale_price_ars, stock_items(purchase_ars), sales(sale_date)')
    .gte('sales.sale_date', `${from}T00:00:00Z`)
    .lte('sales.sale_date', `${to}T23:59:59Z`);

  if (itemsError) {
    return res.status(400).json({ error: { code: 'finance_fetch_failed', message: 'Sale items query failed', details: itemsError.message } });
  }

  const total_sales_ars = (sales ?? []).reduce((sum, sale) => sum + Number(sale.total_ars ?? 0), 0);
  const total_items_sold = (saleItems ?? []).length;
  const estimated_margin_ars = (saleItems ?? []).reduce((sum, item) => {
    const purchase = Number(item.stock_items?.purchase_ars ?? 0);
    return sum + (Number(item.sale_price_ars ?? 0) - purchase);
  }, 0);

  const payment_mix: Record<string, number> = {};
  for (const sale of sales ?? []) {
    const method = sale.payment_method || 'unknown';
    payment_mix[method] = (payment_mix[method] || 0) + Number(sale.total_ars ?? 0);
  }

  const { count: openTradeinsCount, error: tradeinsError } = await supabaseAdmin
    .from('trade_ins')
    .select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'valued']);

  if (tradeinsError) {
    return res.status(400).json({ error: { code: 'finance_fetch_failed', message: 'Trade-ins query failed', details: tradeinsError.message } });
  }

  return res.json({
    total_sales_ars,
    total_items_sold,
    estimated_margin_ars,
    payment_mix,
    open_tradeins_count: openTradeinsCount ?? 0
  });
});

export const financeRouter = router;
