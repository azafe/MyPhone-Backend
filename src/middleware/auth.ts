import type { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

const PUBLIC_PATH_PREFIXES = ['/auth/login'];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function normalizeRole(role: unknown): 'owner' | 'admin' | 'seller' | null {
  if (role === 'owner' || role === 'admin' || role === 'seller') {
    return role;
  }
  return null;
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.method === 'OPTIONS' || isPublicPath(req.path)) {
      return next();
    }

    const header = req.header('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Missing Bearer token' } });
    }

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid token', details: userError?.message } });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role, full_name')
      .eq('id', userData.user.id)
      .single();

    if (profileError || !profile) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Profile not found', details: profileError?.message } });
    }

    const role = normalizeRole(profile.role);
    if (!role) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Invalid profile role' } });
    }

    req.user = {
      id: userData.user.id,
      email: userData.user.email ?? null,
      role
    };

    return next();
  } catch (err) {
    return res.status(500).json({ error: { code: 'internal_error', message: 'Auth failed', details: String(err) } });
  }
}
