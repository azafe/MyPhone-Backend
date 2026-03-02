import { createClient } from '@supabase/supabase-js';
import { verifyAppAuthToken, type AppRole } from './appAuthToken.js';

type ResolveError = {
  code: string;
  message: string;
  details?: unknown;
};

export type ResolvedAuthUser = {
  id: string;
  email: string | null;
  role: AppRole;
  full_name: string | null;
};

export type ResolveBearerResult =
  | { ok: true; user: ResolvedAuthUser }
  | { ok: false; status: 401 | 403 | 500; error: ResolveError };

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

function createServiceClient() {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function normalizeRole(role: unknown): AppRole | null {
  if (role === 'owner' || role === 'admin' || role === 'seller') {
    return role;
  }
  return null;
}

function pickBearerToken(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

async function fetchProfileById(
  userId: string
): Promise<{ ok: true; role: AppRole; full_name: string | null } | { ok: false; status: 403; error: ResolveError }> {
  const supabase = createServiceClient();
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    return {
      ok: false,
      status: 403,
      error: {
        code: 'forbidden',
        message: 'Profile not found',
        details: profileError?.message
      }
    };
  }

  const role = normalizeRole(profile.role);
  if (!role) {
    return {
      ok: false,
      status: 403,
      error: {
        code: 'forbidden',
        message: 'Invalid profile role'
      }
    };
  }

  return {
    ok: true,
    role,
    full_name: typeof profile.full_name === 'string' && profile.full_name.trim() ? profile.full_name.trim() : null
  };
}

export async function resolveBearerUser(authorization: string | undefined | null): Promise<ResolveBearerResult> {
  const token = pickBearerToken(authorization);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: {
        code: 'unauthorized',
        message: 'Missing Bearer token'
      }
    };
  }

  try {
    const appToken = verifyAppAuthToken(token);
    const profile = await fetchProfileById(appToken.sub);
    if (!profile.ok) {
      return profile;
    }

    return {
      ok: true,
      user: {
        id: appToken.sub,
        email: appToken.email ?? null,
        role: profile.role,
        full_name: profile.full_name
      }
    };
  } catch {
    // Fallback to Supabase access token.
  }

  const supabase = createServiceClient();
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return {
      ok: false,
      status: 401,
      error: {
        code: 'unauthorized',
        message: 'Invalid token',
        details: userError?.message
      }
    };
  }

  const profile = await fetchProfileById(userData.user.id);
  if (!profile.ok) {
    return profile;
  }

  return {
    ok: true,
    user: {
      id: userData.user.id,
      email: userData.user.email ?? null,
      role: profile.role,
      full_name: profile.full_name
    }
  };
}
