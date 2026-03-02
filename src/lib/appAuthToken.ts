import jwt from 'jsonwebtoken';

export type AppRole = 'owner' | 'admin' | 'seller';

type AppTokenPayload = {
  sub: string;
  email: string | null;
  role: AppRole;
  type: 'myphone_access';
};

const TOKEN_SECRET = process.env.AUTH_JWT_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
export const APP_AUTH_TOKEN_TTL_SECONDS = (() => {
  const candidate = Number(process.env.AUTH_JWT_TTL_SEC ?? 60 * 60 * 12);
  if (!Number.isFinite(candidate) || candidate <= 0) return 60 * 60 * 12;
  return Math.floor(candidate);
})();

if (!TOKEN_SECRET || TOKEN_SECRET.trim().length < 16) {
  throw new Error('Missing AUTH_JWT_SECRET (or fallback SUPABASE_SERVICE_ROLE_KEY) for app auth token');
}

export function signAppAuthToken(input: { userId: string; email: string | null; role: AppRole }) {
  const payload: AppTokenPayload = {
    sub: input.userId,
    email: input.email,
    role: input.role,
    type: 'myphone_access'
  };

  return jwt.sign(payload, TOKEN_SECRET, {
    algorithm: 'HS256',
    expiresIn: APP_AUTH_TOKEN_TTL_SECONDS
  });
}

export function verifyAppAuthToken(token: string) {
  const decoded = jwt.verify(token, TOKEN_SECRET, { algorithms: ['HS256'] }) as AppTokenPayload;
  if (!decoded || decoded.type !== 'myphone_access' || !decoded.sub || !decoded.role) {
    throw new Error('invalid_app_token_payload');
  }
  return decoded;
}
