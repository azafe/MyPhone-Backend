import { Router } from 'express';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

router.get('/', requireRole('admin', 'seller'), async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('plan_canje_values')
    .select('id, label, min_price_ars, max_price_ars, trade_value_ars, trade_value_pct, is_active, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('min_price_ars', { ascending: true });

  if (error) {
    // If the table does not exist yet in an environment, keep endpoint stable.
    if (error.code === '42P01' || error.message.toLowerCase().includes('plan_canje_values')) {
      return res.json({ values: [] });
    }
    return res.status(400).json({
      error: { code: 'plan_canje_fetch_failed', message: 'Fetch failed', details: error.message }
    });
  }

  return res.json({ values: data ?? [] });
});

export const planCanjeValuesRouter = router;
