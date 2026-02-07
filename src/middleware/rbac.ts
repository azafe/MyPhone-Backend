import type { Request, Response, NextFunction } from 'express';

type Role = 'admin' | 'seller';

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Insufficient role' } });
    }
    return next();
  };
}
