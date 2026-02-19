import type { SupabaseClient, User } from '@supabase/supabase-js';

export type SeedUserRole = 'seller' | 'admin';

export type SeedUserDefinition = {
  email: string;
  password: string;
  full_name: string;
  role: SeedUserRole;
};

export type SeedUserResult = {
  email: string;
  user_id: string | null;
  status: 'created' | 'already_exists' | 'failed';
  profile_updated: boolean;
  password_reset: boolean;
  warnings: string[];
  errors: string[];
};

export type SeedUsersSummary = {
  created: number;
  already_exists: number;
  updated_profiles: number;
  password_resets: number;
  failed: number;
  results: SeedUserResult[];
};

export type SeedUsersOptions = {
  supabase: SupabaseClient;
  users?: SeedUserDefinition[];
  resetPasswords?: boolean;
};

const DEFAULT_SEED_USERS: SeedUserDefinition[] = [
  { email: 'bruno@gmail.com', password: '123456', full_name: 'Bruno', role: 'seller' },
  { email: 'lourdes@gmail.com', password: '123456', full_name: 'Lourdes', role: 'seller' },
  { email: 'turco@gmail.com', password: '123456', full_name: 'Turco', role: 'seller' },
  { email: 'mocho@gmail.com', password: '123456', full_name: 'Mocho', role: 'admin' }
];

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isDuplicateAuthUserError(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('already been registered') || text.includes('user already registered');
}

function isProfileMissingColumnError(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('could not find') && text.includes('column');
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function findAuthUserByEmail(supabase: SupabaseClient, email: string): Promise<User | null> {
  const target = normalizeEmail(email);
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`auth_list_users_failed: ${error.message}`);
    }

    const users = data?.users ?? [];
    const found = users.find((user) => normalizeEmail(user.email ?? '') === target);
    if (found) {
      return found;
    }

    if (users.length < perPage) {
      break;
    }
  }

  return null;
}

async function getOrCreateAuthUser(
  supabase: SupabaseClient,
  userSeed: SeedUserDefinition
): Promise<{ user: User; created: boolean }> {
  const existingUser = await findAuthUserByEmail(supabase, userSeed.email);
  if (existingUser) {
    return { user: existingUser, created: false };
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: userSeed.email,
    password: userSeed.password,
    email_confirm: true
  });

  if (error) {
    if (isDuplicateAuthUserError(error.message)) {
      const racedUser = await findAuthUserByEmail(supabase, userSeed.email);
      if (racedUser) {
        return { user: racedUser, created: false };
      }
    }
    throw new Error(`auth_create_failed: ${error.message}`);
  }

  if (!data?.user) {
    throw new Error('auth_create_failed: user_not_returned');
  }

  return { user: data.user, created: true };
}

async function upsertProfile(
  supabase: SupabaseClient,
  userSeed: SeedUserDefinition,
  userId: string
): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  const updatedAt = new Date().toISOString();
  const fullPayload = {
    id: userId,
    email: userSeed.email,
    full_name: userSeed.full_name,
    role: userSeed.role,
    updated_at: updatedAt
  };

  const fallbackPayloads = [
    fullPayload,
    { id: userId, full_name: userSeed.full_name, role: userSeed.role, updated_at: updatedAt },
    { id: userId, email: userSeed.email, full_name: userSeed.full_name, role: userSeed.role },
    { id: userId, full_name: userSeed.full_name, role: userSeed.role }
  ];

  let usedFallback = false;

  for (const payload of fallbackPayloads) {
    const { error } = await supabase.from('profiles').upsert(payload, { onConflict: 'id' });
    if (!error) {
      return usedFallback ? { ok: true, warning: 'profile_columns_fallback_applied' } : { ok: true };
    }

    if (!isProfileMissingColumnError(error.message)) {
      return { ok: false, error: `profile_upsert_failed: ${error.message}` };
    }

    usedFallback = true;
  }

  return { ok: false, error: 'profile_upsert_failed: unsupported_profiles_shape' };
}

export async function seedInitialUsers(options: SeedUsersOptions): Promise<SeedUsersSummary> {
  const users = options.users ?? DEFAULT_SEED_USERS;
  const resetPasswords = options.resetPasswords ?? false;

  const summary: SeedUsersSummary = {
    created: 0,
    already_exists: 0,
    updated_profiles: 0,
    password_resets: 0,
    failed: 0,
    results: []
  };

  for (const userSeed of users) {
    const result: SeedUserResult = {
      email: userSeed.email,
      user_id: null,
      status: 'failed',
      profile_updated: false,
      password_reset: false,
      warnings: [],
      errors: []
    };

    try {
      const { user, created } = await getOrCreateAuthUser(options.supabase, userSeed);
      result.user_id = user.id;
      result.status = created ? 'created' : 'already_exists';

      if (created) {
        summary.created += 1;
      } else {
        summary.already_exists += 1;
      }

      const profileUpsert = await upsertProfile(options.supabase, userSeed, user.id);
      if (!profileUpsert.ok) {
        result.status = 'failed';
        result.errors.push(profileUpsert.error);
        summary.failed += 1;
        summary.results.push(result);
        continue;
      }

      result.profile_updated = true;
      summary.updated_profiles += 1;
      if (profileUpsert.warning) {
        result.warnings.push(profileUpsert.warning);
      }

      if (resetPasswords) {
        const { error: resetError } = await options.supabase.auth.admin.updateUserById(user.id, {
          password: userSeed.password
        });
        if (resetError) {
          result.status = 'failed';
          result.errors.push(`password_reset_failed: ${resetError.message}`);
          summary.failed += 1;
        } else {
          result.password_reset = true;
          summary.password_resets += 1;
        }
      }
    } catch (error) {
      result.status = 'failed';
      result.errors.push(asErrorMessage(error));
      summary.failed += 1;
    }

    summary.results.push(result);
  }

  return summary;
}

export function getDefaultSeedUsers(): SeedUserDefinition[] {
  return DEFAULT_SEED_USERS.map((user) => ({ ...user }));
}
