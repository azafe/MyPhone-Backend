import type { Request, Response, NextFunction } from 'express';

export type Role = 'owner' | 'admin' | 'seller';

const ROLE_RANK: Record<Role, number> = {
  seller: 1,
  admin: 2,
  owner: 3
};

function isRole(value: unknown): value is Role {
  return value === 'seller' || value === 'admin' || value === 'owner';
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const currentRole = req.user?.role;
    if (!isRole(currentRole)) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Insufficient role' } });
    }

    const allowed = roles.some((role) => ROLE_RANK[currentRole] >= ROLE_RANK[role]);
    if (!allowed) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Insufficient role' } });
    }

    return next();
  };
}
