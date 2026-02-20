import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();
const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabaseService = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

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
  role: z.enum(['seller', 'admin'])
});

const patchSchema = z.object({
  full_name: z.string().min(1).optional(),
  role: z.enum(['seller', 'admin']).optional()
});

type AuthUserLike = {
  id: string;
  email?: string | null;
  banned_until?: string | null;
};

type ProfileLike = {
  id: string;
  full_name: string | null;
  role: string | null;
};

function isEnabledAuthUser(user: AuthUserLike): boolean {
  const bannedUntil = user.banned_until;
  if (!bannedUntil) {
    return true;
  }

  const bannedUntilTs = Date.parse(bannedUntil);
  if (!Number.isFinite(bannedUntilTs)) {
    return false;
  }

  return bannedUntilTs <= Date.now();
}

async function listAllAuthUsers(): Promise<AuthUserLike[]> {
  const users: AuthUserLike[] = [];
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabaseService.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw error;
    }

    const batch = (data?.users ?? []) as AuthUserLike[];
    users.push(...batch);

    if (batch.length < perPage) {
      break;
    }
  }

  return users;
}

router.get('/', requireRole('admin'), async (_req, res) => {
  try {
    const authUsers = await listAllAuthUsers();

    if (authUsers.length === 0) {
      return res.json({ users: [] });
    }

    const profileIds = authUsers.map((user) => user.id);
    const { data: profiles, error: profilesError } = await supabaseService
      .from('profiles')
      .select('id, full_name, role')
      .in('id', profileIds);

    if (profilesError) {
      return res.status(400).json({
        error: {
          code: 'users_fetch_failed',
          message: 'Profiles query failed',
          details: profilesError.message
        }
      });
    }

    const profileMap = new Map<string, ProfileLike>(
      (profiles ?? []).map((profile) => [profile.id, profile as ProfileLike])
    );

    const users = authUsers
      .map((user) => {
        const profile = profileMap.get(user.id);
        if (!profile || !isManagedRole(profile.role)) {
          return null;
        }

        return {
          id: user.id,
          email: user.email ?? null,
          full_name: profile.full_name ?? user.email ?? '',
          role: profile.role,
          is_enabled: isEnabledAuthUser(user)
        };
      })
      .filter((value): value is { id: string; email: string | null; full_name: string; role: 'seller' | 'admin' | 'owner'; is_enabled: boolean } => Boolean(value))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));

    return res.json({ users });
  } catch (error) {
    return res.status(400).json({
      error: {
        code: 'users_fetch_failed',
        message: 'Users fetch failed',
        details: error instanceof Error ? error.message : String(error)
      }
    });
  }
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

  const { data: userData, error: userError } = await supabaseService.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name,
      role
    }
  });

  if (userError || !userData?.user) {
    return res.status(400).json({ error: { code: 'user_create_failed', message: 'Auth create failed', details: userError?.message } });
  }

  let profileSynced = false;
  let profileSyncError: string | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data: existingProfile, error: existingProfileError } = await supabaseService
      .from('profiles')
      .select('id')
      .eq('id', userData.user.id)
      .maybeSingle();

    if (existingProfileError) {
      profileSyncError = existingProfileError.message;
      break;
    }

    if (!existingProfile?.id) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }

    const { error: profileError } = await supabaseService
      .from('profiles')
      .update({ full_name, role })
      .eq('id', userData.user.id)
      .select('id');

    if (profileError) {
      profileSyncError = profileError.message;
      break;
    }

    profileSynced = true;
    break;
  }

  if (!profileSynced) {
    await supabaseService.auth.admin.deleteUser(userData.user.id);
    return res.status(400).json({ error: { code: 'profile_create_failed', message: 'Profile sync failed', details: profileSyncError ?? 'profile_not_ready' } });
  }

  await supabaseService
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

  return res.status(201).json({
    user_id: userData.user.id,
    user: {
      id: userData.user.id,
      email,
      full_name,
      role,
      is_enabled: true
    }
  });
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid patch payload', details: parsed.error.flatten() } });
  }

  const { data: beforeProfile } = await supabaseService
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

  if (targetRole === 'owner' && desiredRole) {
    return res.status(409).json({ error: { code: 'protected_role', message: 'Owner role cannot be changed via this endpoint' } });
  }

  if (req.user?.id === req.params.id && desiredRole && ROLE_RANK[desiredRole] < ROLE_RANK[targetRole]) {
    return res.status(403).json({ error: { code: 'forbidden_role_change', message: 'You cannot self-demote your role' } });
  }

  if (desiredRole === 'admin' && targetRole !== 'admin' && actorRole !== 'owner') {
    return res.status(403).json({ error: { code: 'forbidden_role_change', message: 'Only owner can promote users to admin' } });
  }

  const { data, error } = await supabaseService
    .from('profiles')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select('id, role, full_name')
    .single();

  if (error || !data) {
    return res.status(400).json({ error: { code: 'profile_update_failed', message: 'Profile update failed', details: error?.message } });
  }

  await supabaseService
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
