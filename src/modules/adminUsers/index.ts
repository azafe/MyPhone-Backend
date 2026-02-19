import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  full_name: z.string().min(1),
  role: z.enum(['seller', 'admin', 'owner'])
});

const patchSchema = z.object({
  full_name: z.string().min(1).optional(),
  role: z.enum(['seller', 'admin', 'owner']).optional()
});

router.post('/', requireRole('admin'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid user payload', details: parsed.error.flatten() } });
  }

  const { email, password, full_name, role } = parsed.data;
  const actorRole = req.user?.role ?? null;
  if (role === 'owner' && actorRole !== 'owner') {
    return res.status(403).json({ error: { code: 'forbidden', message: 'Only owner can assign owner role' } });
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (userError || !userData?.user) {
    return res.status(400).json({ error: { code: 'user_create_failed', message: 'Auth create failed', details: userError?.message } });
  }

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: userData.user.id, full_name, role });

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(userData.user.id);
    return res.status(400).json({ error: { code: 'profile_create_failed', message: 'Profile insert failed', details: profileError.message } });
  }

  await supabaseAdmin
    .from('audit_logs')
    .insert({
      actor_user_id: req.user?.id ?? null,
      action: 'user_role_changed',
      entity_type: 'profile',
      entity_id: userData.user.id,
      before_json: null,
      after_json: { role, full_name, email },
      meta_json: { source: 'admin_users_create' }
    });

  return res.status(201).json({ user_id: userData.user.id });
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid patch payload', details: parsed.error.flatten() } });
  }

  if (parsed.data.role === 'owner' && req.user?.role !== 'owner') {
    return res.status(403).json({ error: { code: 'forbidden', message: 'Only owner can assign owner role' } });
  }

  const { data: beforeProfile } = await supabaseAdmin
    .from('profiles')
    .select('role, full_name')
    .eq('id', req.params.id)
    .maybeSingle();

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select('id, role, full_name')
    .single();

  if (error || !data) {
    return res.status(400).json({ error: { code: 'profile_update_failed', message: 'Profile update failed', details: error?.message } });
  }

  await supabaseAdmin
    .from('audit_logs')
    .insert({
      actor_user_id: req.user?.id ?? null,
      action: 'user_role_changed',
      entity_type: 'profile',
      entity_id: data.id,
      before_json: beforeProfile ?? null,
      after_json: { role: data.role, full_name: data.full_name },
      meta_json: { source: 'admin_users_patch' }
    });

  return res.json({ user_id: data.id });
});

export const adminUsersRouter = router;
