import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getDefaultSeedUsers, seedInitialUsers } from '../src/modules/adminUsers/seedUsersService.js';

function requiredEnv(name: 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolveResetPasswordsFlag(args: string[]): boolean {
  const hasResetFlag = args.includes('--reset-passwords');
  const hasNoResetFlag = args.includes('--no-reset-passwords');

  if (hasResetFlag && hasNoResetFlag) {
    throw new Error('Use either --reset-passwords or --no-reset-passwords, not both');
  }

  if (hasResetFlag) {
    return true;
  }
  if (hasNoResetFlag) {
    return false;
  }

  return parseBooleanEnv(process.env.SEED_USERS_RESET_PASSWORDS, false);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resetPasswords = resolveResetPasswordsFlag(args);

  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const summary = await seedInitialUsers({
    supabase,
    users: getDefaultSeedUsers(),
    resetPasswords
  });

  // eslint-disable-next-line no-console
  console.log('Seed users summary');
  // eslint-disable-next-line no-console
  console.log(`- created: ${summary.created}`);
  // eslint-disable-next-line no-console
  console.log(`- already_exists: ${summary.already_exists}`);
  // eslint-disable-next-line no-console
  console.log(`- updated_profiles: ${summary.updated_profiles}`);
  // eslint-disable-next-line no-console
  console.log(`- password_resets: ${summary.password_resets}`);
  // eslint-disable-next-line no-console
  console.log(`- failed: ${summary.failed}`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[seed:users] ${String(error)}`);
  process.exit(1);
});
