import type { Request, Response, NextFunction } from 'express';
import { resolveBearerUser } from '../lib/resolveAuthBearer.js';

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.method === 'OPTIONS') {
      return next();
    }

    const authResult = await resolveBearerUser(req.header('authorization'));
    if (!authResult.ok) {
      return res.status(authResult.status).json({ error: authResult.error });
    }

    req.user = {
      id: authResult.user.id,
      email: authResult.user.email,
      role: authResult.user.role
    };

    return next();
  } catch (err) {
    return res.status(500).json({ error: { code: 'internal_error', message: 'Auth failed', details: String(err) } });
  }
}
