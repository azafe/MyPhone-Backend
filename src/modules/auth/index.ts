import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const router = Router();
const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

function createAuthClient() {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

function normalizeRole(role: unknown): 'owner' | 'admin' | 'seller' | null {
  if (role === 'owner' || role === 'admin' || role === 'seller') {
    return role;
  }
  return null;
}

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid login payload',
        details: parsed.error.flatten()
      }
    });
  }

  const supabaseAuth = createAuthClient();

  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password
  });

  if (error || !data.session || !data.user) {
    return res.status(401).json({
      error: {
        code: 'invalid_credentials',
        message: 'Invalid email or password',
        details: error?.message
      }
    });
  }

  return res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    token_type: data.session.token_type,
    expires_in: data.session.expires_in,
    user: {
      id: data.user.id,
      email: data.user.email ?? null
    }
  });
});

router.get('/me', async (req, res) => {
  const authorization = req.header('authorization') || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Missing Bearer token'
      }
    });
  }

  const supabaseAuth = createAuthClient();
  const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);

  if (userError || !userData?.user) {
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Invalid token',
        details: userError?.message
      }
    });
  }

  const { data: profile, error: profileError } = await supabaseAuth
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', userData.user.id)
    .single();

  if (profileError || !profile) {
    return res.status(403).json({
      error: {
        code: 'forbidden',
        message: 'Profile not found',
        details: profileError?.message
      }
    });
  }

  const role = normalizeRole(profile.role);
  if (!role) {
    return res.status(403).json({
      error: {
        code: 'forbidden',
        message: 'Invalid profile role'
      }
    });
  }

  return res.json({
    id: userData.user.id,
    email: userData.user.email ?? null,
    full_name: profile.full_name ?? userData.user.email ?? 'User',
    role
  });
});

export const authRouter = router;
