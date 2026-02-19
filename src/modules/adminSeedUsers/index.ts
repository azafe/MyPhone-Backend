import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';
import { seedInitialUsers } from '../adminUsers/seedUsersService.js';

const router = Router();

const seedUsersSchema = z.object({
  reset_passwords: z.boolean().optional()
});

router.post('/', requireRole('admin'), async (req, res) => {
  const seedSecret = process.env.SEED_USERS_SECRET;
  if (!seedSecret || seedSecret.trim().length === 0) {
    return res.status(503).json({
      error: {
        code: 'config_error',
        message: 'SEED_USERS_SECRET is not configured'
      }
    });
  }

  const providedSecret = req.header('x-seed-secret');
  if (!providedSecret || providedSecret !== seedSecret) {
    return res.status(403).json({
      error: {
        code: 'forbidden',
        message: 'Invalid seed secret'
      }
    });
  }

  const parsed = seedUsersSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid seed users payload',
        details: parsed.error.flatten()
      }
    });
  }

  try {
    const summary = await seedInitialUsers({
      supabase: supabaseAdmin,
      resetPasswords: parsed.data.reset_passwords ?? false
    });

    return res.json(summary);
  } catch (error) {
    return res.status(500).json({
      error: {
        code: 'seed_users_failed',
        message: 'Failed to seed users',
        details: String(error)
      }
    });
  }
});

export const adminSeedUsersRouter = router;
