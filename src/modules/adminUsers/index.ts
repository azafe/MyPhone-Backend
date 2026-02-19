import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const ROLE_RANK = {
  seller: 1,
  admin: 2,
  owner: 3
} as const;

function isManagedRole(role: unknown): role is keyof typeof ROLE_RANK {
  return role === 'seller' || role === 'admin' || role === 'owner';
}

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
  if (role === 'admin' && actorRole !== 'owner') {
    return res.status(403).json({ error: { code: 'forbidden_role_change', message: 'Only owner can promote users to admin' } });
  }
  if (role === 'owner' && actorRole !== 'owner') {
    return res.status(403).json({ error: { code: 'forbidden_role_change', message: 'Only owner can assign owner role' } });
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

  const { data: beforeProfile } = await supabaseAdmin
    .from('profiles')
    .select('role, full_name')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!beforeProfile) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Profile not found' } });
  }

  const desiredRole = parsed.data.role;
  const actorRole = req.user?.role ?? null;
  const targetRole = beforeProfile.role;
  if (!isManagedRole(targetRole)) {
    return res.status(409).json({ error: { code: 'protected_role', message: 'Target profile role is protected' } });
  }

  if (targetRole === 'owner' && desiredRole && desiredRole !== 'owner') {
    return res.status(409).json({ error: { code: 'protected_role', message: 'Owner role cannot be changed via this endpoint' } });
  }

  if (req.user?.id === req.params.id && desiredRole && ROLE_RANK[desiredRole] < ROLE_RANK[targetRole]) {
    return res.status(403).json({ error: { code: 'forbidden_role_change', message: 'You cannot self-demote your role' } });
  }

  if (desiredRole === 'admin' && targetRole !== 'admin' && actorRole !== 'owner') {
    return res.status(403).json({ error: { code: 'forbidden_role_change', message: 'Only owner can promote users to admin' } });
  }

  if (desiredRole === 'owner' && actorRole !== 'owner') {
    return res.status(403).json({ error: { code: 'forbidden_role_change', message: 'Only owner can assign owner role' } });
  }

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
