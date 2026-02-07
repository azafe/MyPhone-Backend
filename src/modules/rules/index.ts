import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const ruleSchema = z.object({
  card_brand: z.string().min(1),
  installments: z.number().int().positive(),
  surcharge_pct: z.number().min(0),
  is_active: z.boolean().default(true)
});

router.get('/', requireRole('admin'), async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('installment_rules')
    .select('*')
    .order('card_brand', { ascending: true });

  if (error) {
    return res.status(400).json({ error: { code: 'rules_fetch_failed', message: 'Fetch failed', details: error.message } });
  }

  return res.json({ rules: data });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid rule payload', details: parsed.error.flatten() } });
  }

  const { data, error } = await supabaseAdmin
    .from('installment_rules')
    .insert(parsed.data)
    .select('id')
    .single();

  if (error || !data) {
    return res.status(400).json({ error: { code: 'rule_create_failed', message: 'Insert failed', details: error?.message } });
  }

  return res.status(201).json({ rule_id: data.id });
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const parsed = ruleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid rule patch', details: parsed.error.flatten() } });
  }

  const { data, error } = await supabaseAdmin
    .from('installment_rules')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    return res.status(400).json({ error: { code: 'rule_update_failed', message: 'Update failed', details: error?.message } });
  }

  return res.json({ rule_id: data.id });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { error } = await supabaseAdmin
    .from('installment_rules')
    .delete()
    .eq('id', req.params.id);

  if (error) {
    return res.status(400).json({ error: { code: 'rule_delete_failed', message: 'Delete failed', details: error.message } });
  }

  return res.status(204).send();
});

export const installmentRulesRouter = router;
