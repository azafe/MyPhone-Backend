import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

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

  const { data, error } = await supabaseAdmin.auth.signInWithPassword({
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

export const authRouter = router;
