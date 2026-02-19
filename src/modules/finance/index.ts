import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

const accountsReceivableQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seller_id: z.string().uuid().optional(),
  status: z.enum(['pending', 'partial', 'paid']).optional()
});

type PaymentMixRow = {
  method: string;
  total: number;
};

router.get('/summary', requireRole('admin'), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid date range', details: parsed.error.flatten() } });
  }

  const { from, to } = parsed.data;

  const { data: sales, error: salesError } = await supabaseAdmin
    .from('sales')
    .select('id, sale_date, total_ars, payment_method, status')
    .gte('sale_date', `${from}T00:00:00Z`)
    .lte('sale_date', `${to}T23:59:59Z`)
    .eq('status', 'completed');

  if (salesError) {
    return res.status(400).json({ error: { code: 'finance_fetch_failed', message: 'Sales query failed', details: salesError.message } });
  }

  const { data: saleItems, error: itemsError } = await supabaseAdmin
    .from('sale_items')
    .select('qty, sale_price_ars, subtotal_ars, unit_cost_ars, stock_items(purchase_ars), sales!inner(sale_date, status)')
    .gte('sales.sale_date', `${from}T00:00:00Z`)
    .lte('sales.sale_date', `${to}T23:59:59Z`)
    .eq('sales.status', 'completed');

  if (itemsError) {
    return res.status(400).json({ error: { code: 'finance_fetch_failed', message: 'Sale items query failed', details: itemsError.message } });
  }

  const sales_total = (sales ?? []).reduce((sum, sale) => sum + Number(sale.total_ars ?? 0), 0);
  const sales_count = (sales ?? []).length;
  const ticket_avg = sales_count > 0 ? sales_total / sales_count : 0;

  let margin_total = 0;
  let total_items_sold = 0;

  for (const item of saleItems ?? []) {
    const qty = Number(item.qty ?? 1);
    const salePrice = Number(item.sale_price_ars ?? 0);
    const subtotal = Number(item.subtotal_ars ?? (salePrice * qty));
    const stockItem = Array.isArray(item.stock_items) ? item.stock_items[0] : item.stock_items;
    const unitCost = Number(item.unit_cost_ars ?? stockItem?.purchase_ars ?? 0);

    total_items_sold += qty;
    margin_total += subtotal - (unitCost * qty);
  }

  const paymentMixMap: Record<string, number> = {};
  for (const sale of sales ?? []) {
    const method = sale.payment_method || 'unknown';
    paymentMixMap[method] = (paymentMixMap[method] || 0) + Number(sale.total_ars ?? 0);
  }

  const payment_mix: PaymentMixRow[] = Object.entries(paymentMixMap)
    .map(([method, total]) => ({ method, total }))
    .sort((a, b) => b.total - a.total);

  const { count: openTradeinsCount, error: tradeinsError } = await supabaseAdmin
    .from('trade_ins')
    .select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'valued']);

  if (tradeinsError) {
    return res.status(400).json({ error: { code: 'finance_fetch_failed', message: 'Trade-ins query failed', details: tradeinsError.message } });
  }

  const open_tradeins = Number(openTradeinsCount ?? 0);

  return res.json({
    sales_total,
    sales_count,
    margin_total,
    ticket_avg,
    payment_mix,
    open_tradeins,

    // Legacy aliases for current frontend compatibility
    total_sales_ars: sales_total,
    total_items_sold,
    estimated_margin_ars: margin_total,
    payment_mix_map: paymentMixMap,
    open_tradeins_count: open_tradeins,
    sales_month: sales_total,
    sales_month_usd: 0,
    margin_month: margin_total
  });
});

router.get('/accounts-receivable', requireRole('admin'), async (req, res) => {
  const parsed = accountsReceivableQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid accounts receivable query',
        details: parsed.error.flatten()
      }
    });
  }

  const { from, to, seller_id, status } = parsed.data;

  let salesQuery = supabaseAdmin
    .from('sales')
    .select('id, sale_date, seller_id, total_ars, paid_ars, balance_due_ars, receivable_status, customers(name, phone)')
    .gte('sale_date', `${from}T00:00:00Z`)
    .lte('sale_date', `${to}T23:59:59Z`)
    .eq('status', 'completed')
    .order('sale_date', { ascending: false });

  if (seller_id) {
    salesQuery = salesQuery.eq('seller_id', seller_id);
  }

  if (status) {
    salesQuery = salesQuery.eq('receivable_status', status);
  }

  const { data: sales, error } = await salesQuery;
  if (error) {
    return res.status(400).json({
      error: {
        code: 'finance_fetch_failed',
        message: 'Accounts receivable query failed',
        details: error.message
      }
    });
  }

  const now = Date.now();
  const receivables = (sales ?? []).map((sale) => {
    const customer = Array.isArray(sale.customers) ? sale.customers[0] : sale.customers;
    const saleDate = new Date(sale.sale_date);
    const daysSinceSale = Number.isNaN(saleDate.getTime())
      ? 0
      : Math.max(0, Math.floor((now - saleDate.getTime()) / (24 * 60 * 60 * 1000)));

    return {
      sale_id: sale.id,
      customer_name: customer?.name ?? null,
      customer_phone: customer?.phone ?? null,
      sale_date: sale.sale_date,
      total_ars: Number(sale.total_ars ?? 0),
      paid_ars: Number(sale.paid_ars ?? 0),
      balance_due_ars: Number(sale.balance_due_ars ?? 0),
      status: sale.receivable_status ?? 'pending',
      days_since_sale: daysSinceSale,
      seller_id: sale.seller_id ?? null
    };
  });

  return res.json({ receivables });
});

export const financeRouter = router;
