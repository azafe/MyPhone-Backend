import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { z } from 'zod';
import { APP_AUTH_TOKEN_TTL_SECONDS, signAppAuthToken } from '../../lib/appAuthToken.js';
import { resolveBearerUser } from '../../lib/resolveAuthBearer.js';

const router = Router();
const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const PASSKEY_RP_NAME = process.env.PASSKEY_RP_NAME?.trim() || 'MyPhone';
const DEFAULT_PASSKEY_ORIGINS = [
  'https://myphonetuc.netlify.app',
  'https://www.myphonetuc.netlify.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
];
const PASSKEY_ALLOWED_ORIGINS = (() => {
  const envOrigins = (process.env.PASSKEY_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (envOrigins.length > 0) {
    return envOrigins;
  }

  return DEFAULT_PASSKEY_ORIGINS;
})();

const PASSKEY_CHALLENGE_TTL_MS = (() => {
  const raw = Number(process.env.PASSKEY_CHALLENGE_TTL_SEC ?? 300);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 300_000;
  }
  return Math.floor(raw) * 1000;
})();

type PasskeyFlow = 'register' | 'login';

type PendingPasskeyChallenge = {
  id: string;
  flow: PasskeyFlow;
  challenge: string;
  userId: string | null;
  email: string | null;
  expectedOrigin: string;
  expectedRpId: string;
  expiresAt: number;
};

type AuthPasskeyRow = {
  id: string;
  user_id: string;
  user_email: string | null;
  credential_id: string;
  credential_public_key: string;
  counter: number | null;
  transports: string[] | null;
  device_type: string | null;
  backed_up: boolean | null;
  is_enabled: boolean | null;
};

const pendingPasskeyChallenges = new Map<string, PendingPasskeyChallenge>();

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

const forgotPasswordSchema = z.object({
  email: z.string().email()
});

const resetPasswordSchema = z.object({
  access_token: z.string().min(10),
  password: z.string().min(6)
});

const passkeyLoginOptionsSchema = z.object({
  email: z.string().email().optional()
});

const passkeyVerifySchema = z.object({
  challenge_id: z.string().min(8),
  response: z.record(z.unknown())
});

function normalizeRole(role: unknown): 'owner' | 'admin' | 'seller' | null {
  if (role === 'owner' || role === 'admin' || role === 'seller') {
    return role;
  }
  return null;
}

function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return normalized || null;
}

function cleanupPendingChallenges() {
  const now = Date.now();
  for (const [id, challenge] of pendingPasskeyChallenges.entries()) {
    if (challenge.expiresAt <= now) {
      pendingPasskeyChallenges.delete(id);
    }
  }
}

function createPendingChallenge(input: Omit<PendingPasskeyChallenge, 'id' | 'expiresAt'>): string {
  cleanupPendingChallenges();
  const id = randomUUID();
  pendingPasskeyChallenges.set(id, {
    ...input,
    id,
    expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS
  });
  return id;
}

function takePendingChallenge(challengeId: string, flow: PasskeyFlow): PendingPasskeyChallenge | null {
  cleanupPendingChallenges();
  const challenge = pendingPasskeyChallenges.get(challengeId);
  if (!challenge || challenge.flow !== flow) {
    return null;
  }
  pendingPasskeyChallenges.delete(challengeId);
  if (challenge.expiresAt < Date.now()) {
    return null;
  }
  return challenge;
}

function isAllowedPasskeyOrigin(origin: string): boolean {
  if (PASSKEY_ALLOWED_ORIGINS.includes(origin)) {
    return true;
  }
  return /^https:\/\/[a-z0-9-]+\.netlify\.app$/i.test(origin);
}

function resolveOriginFromRequest(req: Request): string | null {
  const originHeader = req.header('origin')?.trim();
  if (originHeader && isAllowedPasskeyOrigin(originHeader)) {
    return originHeader;
  }

  const referer = req.header('referer');
  if (referer) {
    try {
      const url = new URL(referer);
      const refererOrigin = url.origin;
      if (isAllowedPasskeyOrigin(refererOrigin)) {
        return refererOrigin;
      }
    } catch {
      // Ignore invalid referer header.
    }
  }

  const fallbackOrigin = PASSKEY_ALLOWED_ORIGINS[0] ?? null;
  return fallbackOrigin && isAllowedPasskeyOrigin(fallbackOrigin) ? fallbackOrigin : null;
}

function getRpIdFromOrigin(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function toAuthenticatorTransports(transports: unknown): AuthenticatorTransportFuture[] | undefined {
  if (!Array.isArray(transports)) {
    return undefined;
  }

  const valid = transports.filter((transport): transport is AuthenticatorTransportFuture => {
    return (
      transport === 'ble' ||
      transport === 'cable' ||
      transport === 'hybrid' ||
      transport === 'internal' ||
      transport === 'nfc' ||
      transport === 'smart-card' ||
      transport === 'usb'
    );
  });

  return valid.length > 0 ? valid : undefined;
}

async function requireAuthUser(req: Request, res: Response) {
  const authResult = await resolveBearerUser(req.header('authorization'));
  if (!authResult.ok) {
    res.status(authResult.status).json({ error: authResult.error });
    return null;
  }
  return authResult.user;
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
  const authResult = await resolveBearerUser(req.header('authorization'));
  if (!authResult.ok) {
    return res.status(authResult.status).json({ error: authResult.error });
  }

  return res.json({
    id: authResult.user.id,
    email: authResult.user.email,
    full_name: authResult.user.full_name ?? authResult.user.email ?? 'User',
    role: authResult.user.role
  });
});

router.post('/forgot-password', async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Email inválido',
        details: parsed.error.flatten()
      }
    });
  }

  const appUrl = (process.env.APP_URL ?? 'https://myphonetuc.netlify.app').replace(/\/$/, '');
  const redirectTo = `${appUrl}/reset-password`;

  const supabaseAuth = createAuthClient();
  const { error } = await supabaseAuth.auth.admin.generateLink({
    type: 'recovery',
    email: parsed.data.email,
    options: { redirectTo }
  });

  if (error) {
    console.error('[forgot-password]', error.message);
  }

  // Siempre devolvemos éxito para no revelar si el email existe
  return res.json({
    ok: true,
    message: 'Si el email está registrado, recibirás un enlace para restablecer tu contraseña.'
  });
});

router.post('/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Datos inválidos',
        details: parsed.error.flatten()
      }
    });
  }

  const supabaseAuth = createAuthClient();

  // Verify the access token and get the user
  const { data: userData, error: userError } = await supabaseAuth.auth.getUser(parsed.data.access_token);
  if (userError || !userData.user) {
    return res.status(401).json({
      error: {
        code: 'invalid_token',
        message: 'El enlace de recuperación es inválido o expiró. Solicitá uno nuevo.'
      }
    });
  }

  const { error: updateError } = await supabaseAuth.auth.admin.updateUserById(userData.user.id, {
    password: parsed.data.password
  });

  if (updateError) {
    return res.status(500).json({
      error: {
        code: 'reset_password_failed',
        message: 'No se pudo actualizar la contraseña',
        details: updateError.message
      }
    });
  }

  return res.json({ ok: true, message: 'Contraseña actualizada correctamente.' });
});

router.post('/passkeys/register/options', async (req, res) => {
  const authUser = await requireAuthUser(req, res);
  if (!authUser) return;

  const email = normalizeEmail(authUser.email);
  if (!email) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'User email is required to register passkey'
      }
    });
  }

  const origin = resolveOriginFromRequest(req);
  if (!origin) {
    return res.status(400).json({
      error: {
        code: 'passkey_origin_not_allowed',
        message: 'Origin not allowed for passkey registration'
      }
    });
  }

  const rpID = getRpIdFromOrigin(origin);
  if (!rpID) {
    return res.status(400).json({
      error: {
        code: 'passkey_rpid_invalid',
        message: 'Could not resolve RP ID for passkey registration'
      }
    });
  }

  const supabaseAuth = createAuthClient();
  const { data: existingCredentials, error: credentialsError } = await supabaseAuth
    .from('auth_passkeys')
    .select('credential_id, transports')
    .eq('user_id', authUser.id)
    .eq('is_enabled', true);

  if (credentialsError) {
    return res.status(500).json({
      error: {
        code: 'passkey_register_options_failed',
        message: 'Could not prepare passkey registration',
        details: credentialsError.message
      }
    });
  }

  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID,
    userID: Buffer.from(authUser.id, 'utf8'),
    userName: email,
    userDisplayName: authUser.full_name ?? email,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred'
    },
    excludeCredentials: (existingCredentials ?? []).map((credential) => ({
      id: credential.credential_id,
      type: 'public-key',
      transports: toAuthenticatorTransports(credential.transports)
    }))
  });

  const challengeId = createPendingChallenge({
    flow: 'register',
    challenge: options.challenge,
    userId: authUser.id,
    email,
    expectedOrigin: origin,
    expectedRpId: rpID
  });

  return res.json({
    challenge_id: challengeId,
    options: options as PublicKeyCredentialCreationOptionsJSON
  });
});

router.post('/passkeys/register/verify', async (req, res) => {
  const authUser = await requireAuthUser(req, res);
  if (!authUser) return;

  const parsed = passkeyVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid passkey verification payload',
        details: parsed.error.flatten()
      }
    });
  }

  const pending = takePendingChallenge(parsed.data.challenge_id, 'register');
  if (!pending) {
    return res.status(400).json({
      error: {
        code: 'passkey_challenge_invalid',
        message: 'Passkey challenge expired or invalid'
      }
    });
  }

  if (pending.userId !== authUser.id) {
    return res.status(403).json({
      error: {
        code: 'forbidden',
        message: 'Passkey challenge does not belong to current user'
      }
    });
  }

  let verification;
  try {
    const registrationResponse = parsed.data.response as unknown as RegistrationResponseJSON;
    verification = await verifyRegistrationResponse({
      response: registrationResponse,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.expectedOrigin,
      expectedRPID: pending.expectedRpId,
      requireUserVerification: false
    });
  } catch (error) {
    return res.status(400).json({
      error: {
        code: 'passkey_verification_failed',
        message: 'Passkey registration verification failed',
        details: String(error)
      }
    });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return res.status(401).json({
      error: {
        code: 'passkey_not_verified',
        message: 'Could not verify passkey registration'
      }
    });
  }

  const registrationInfo = verification.registrationInfo;
  const credentialId = registrationInfo.credential.id;
  const publicKeyBase64Url = Buffer.from(registrationInfo.credential.publicKey).toString('base64url');
  const counter = Number(registrationInfo.credential.counter ?? 0);

  const responseTransports = toAuthenticatorTransports(
    (parsed.data.response as unknown as RegistrationResponseJSON).response.transports
  );

  const supabaseAuth = createAuthClient();
  const email = normalizeEmail(authUser.email);

  const { error: upsertError } = await supabaseAuth.from('auth_passkeys').upsert(
    {
      user_id: authUser.id,
      user_email: email,
      credential_id: credentialId,
      credential_public_key: publicKeyBase64Url,
      counter,
      transports: responseTransports ?? null,
      device_type: registrationInfo.credentialDeviceType,
      backed_up: registrationInfo.credentialBackedUp,
      is_enabled: true,
      last_used_at: new Date().toISOString()
    },
    {
      onConflict: 'credential_id'
    }
  );

  if (upsertError) {
    return res.status(500).json({
      error: {
        code: 'passkey_register_failed',
        message: 'Could not save passkey',
        details: upsertError.message
      }
    });
  }

  return res.json({
    ok: true,
    credential_id: credentialId
  });
});

router.post('/passkeys/login/options', async (req, res) => {
  const parsed = passkeyLoginOptionsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid passkey login payload',
        details: parsed.error.flatten()
      }
    });
  }

  const email = normalizeEmail(parsed.data.email);

  const origin = resolveOriginFromRequest(req);
  if (!origin) {
    return res.status(400).json({
      error: {
        code: 'passkey_origin_not_allowed',
        message: 'Origin not allowed for passkey login'
      }
    });
  }

  const rpID = getRpIdFromOrigin(origin);
  if (!rpID) {
    return res.status(400).json({
      error: {
        code: 'passkey_rpid_invalid',
        message: 'Could not resolve RP ID for passkey login'
      }
    });
  }

  let allowCredentials:
    | {
        id: string;
        type: 'public-key';
        transports?: AuthenticatorTransportFuture[];
      }[]
    | undefined;

  if (email) {
    const supabaseAuth = createAuthClient();
    const { data: passkeys, error: passkeysError } = await supabaseAuth
      .from('auth_passkeys')
      .select('credential_id, transports')
      .eq('is_enabled', true)
      .eq('user_email', email)
      .order('created_at', { ascending: false })
      .limit(20);

    if (passkeysError) {
      return res.status(500).json({
        error: {
          code: 'passkey_login_options_failed',
          message: 'Could not prepare passkey login',
          details: passkeysError.message
        }
      });
    }

    if (!passkeys || passkeys.length === 0) {
      return res.status(404).json({
        error: {
          code: 'passkey_not_registered',
          message: 'No passkey found for this email'
        }
      });
    }

    allowCredentials = passkeys.map((passkey) => ({
      id: passkey.credential_id,
      type: 'public-key' as const,
      transports: toAuthenticatorTransports(passkey.transports)
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    ...(allowCredentials ? { allowCredentials } : {})
  });

  const challengeId = createPendingChallenge({
    flow: 'login',
    challenge: options.challenge,
    userId: null,
    email,
    expectedOrigin: origin,
    expectedRpId: rpID
  });

  return res.json({
    challenge_id: challengeId,
    options: options as PublicKeyCredentialRequestOptionsJSON
  });
});

router.post('/passkeys/login/verify', async (req, res) => {
  const parsed = passkeyVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid passkey login verification payload',
        details: parsed.error.flatten()
      }
    });
  }

  const pending = takePendingChallenge(parsed.data.challenge_id, 'login');
  if (!pending) {
    return res.status(400).json({
      error: {
        code: 'passkey_challenge_invalid',
        message: 'Passkey challenge expired or invalid'
      }
    });
  }

  const authenticationResponse = parsed.data.response as unknown as AuthenticationResponseJSON;
  const credentialId = typeof authenticationResponse.id === 'string' ? authenticationResponse.id : null;
  if (!credentialId) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Passkey credential id is required'
      }
    });
  }

  const supabaseAuth = createAuthClient();
  const { data: passkey, error: passkeyError } = await supabaseAuth
    .from('auth_passkeys')
    .select('id, user_id, user_email, credential_id, credential_public_key, counter, transports, device_type, backed_up, is_enabled')
    .eq('credential_id', credentialId)
    .eq('is_enabled', true)
    .single<AuthPasskeyRow>();

  if (passkeyError || !passkey) {
    return res.status(401).json({
      error: {
        code: 'passkey_not_registered',
        message: 'Passkey not found',
        details: passkeyError?.message
      }
    });
  }

  const passkeyEmail = normalizeEmail(passkey.user_email);
  if (pending.email && passkeyEmail !== pending.email) {
    return res.status(401).json({
      error: {
        code: 'passkey_email_mismatch',
        message: 'Passkey does not match the provided email'
      }
    });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: authenticationResponse,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.expectedOrigin,
      expectedRPID: pending.expectedRpId,
      requireUserVerification: false,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.credential_public_key, 'base64url'),
        counter: Number(passkey.counter ?? 0),
        transports: toAuthenticatorTransports(passkey.transports)
      }
    });
  } catch (error) {
    return res.status(401).json({
      error: {
        code: 'passkey_verification_failed',
        message: 'Could not verify passkey login',
        details: String(error)
      }
    });
  }

  if (!verification.verified) {
    return res.status(401).json({
      error: {
        code: 'passkey_not_verified',
        message: 'Passkey login verification failed'
      }
    });
  }

  const { error: updatePasskeyError } = await supabaseAuth
    .from('auth_passkeys')
    .update({
      counter: verification.authenticationInfo.newCounter,
      device_type: verification.authenticationInfo.credentialDeviceType,
      backed_up: verification.authenticationInfo.credentialBackedUp,
      last_used_at: new Date().toISOString()
    })
    .eq('id', passkey.id);

  if (updatePasskeyError) {
    return res.status(500).json({
      error: {
        code: 'passkey_update_failed',
        message: 'Passkey login succeeded but credential state was not updated',
        details: updatePasskeyError.message
      }
    });
  }

  const { data: profile, error: profileError } = await supabaseAuth
    .from('profiles')
    .select('full_name, role')
    .eq('id', passkey.user_id)
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

  const userEmail = passkeyEmail;
  const accessToken = signAppAuthToken({
    userId: passkey.user_id,
    email: userEmail,
    role
  });

  return res.json({
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: APP_AUTH_TOKEN_TTL_SECONDS,
    user: {
      id: passkey.user_id,
      email: userEmail,
      full_name: profile.full_name ?? userEmail ?? 'User',
      role
    }
  });
});

export const authRouter = router;
