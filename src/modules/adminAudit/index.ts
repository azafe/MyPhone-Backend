import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const querySchema = z.object({
  entity_type: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).optional(),
  actor_user_id: z.string().uuid().optional(),
  query: z.string().trim().min(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  page_size: z.coerce.number().int().positive().max(100).optional().default(30)
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'from must be less or equal to to',
      path: ['from']
    });
  }
});

type AuditRow = {
  id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  meta_json: Record<string, unknown> | null;
  created_at: string;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  role: string | null;
};

router.get('/', requireRole('admin'), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid audit logs query',
        details: parsed.error.flatten()
      }
    });
  }

  const filters = parsed.data;
  const page = filters.page ?? 1;
  const pageSize = filters.page_size ?? 30;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from('audit_logs')
    .select('*', { count: 'exact' });

  if (filters.entity_type) query = query.eq('entity_type', filters.entity_type);
  if (filters.action) query = query.ilike('action', `%${filters.action}%`);
  if (filters.actor_user_id) query = query.eq('actor_user_id', filters.actor_user_id);
  if (filters.query) {
    const search = filters.query.replace(/[%_*]/g, '').trim();
    if (search) {
      query = query.or(`action.ilike.%${search}%,entity_type.ilike.%${search}%`);
    }
  }
  if (filters.from) query = query.gte('created_at', `${filters.from}T00:00:00Z`);
  if (filters.to) query = query.lte('created_at', `${filters.to}T23:59:59Z`);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    return res.status(400).json({
      error: {
        code: 'audit_logs_fetch_failed',
        message: 'Could not fetch audit logs',
        details: error.message
      }
    });
  }

  const logs = (data ?? []) as AuditRow[];
  const actorIds = [...new Set(logs.map((row) => row.actor_user_id).filter((value): value is string => Boolean(value)))];
  let profilesMap = new Map<string, ProfileRow>();

  if (actorIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role')
      .in('id', actorIds);

    if (profilesError) {
      return res.status(400).json({
        error: {
          code: 'audit_logs_fetch_failed',
          message: 'Could not fetch audit actor profiles',
          details: profilesError.message
        }
      });
    }

    profilesMap = new Map((profiles ?? []).map((profile) => [profile.id, profile as ProfileRow]));
  }

  const hydrated = logs.map((row) => {
    const actorProfile = row.actor_user_id ? profilesMap.get(row.actor_user_id) : null;
    return {
      ...row,
      actor: row.actor_user_id
        ? {
          id: row.actor_user_id,
          full_name: actorProfile?.full_name ?? null,
          role: actorProfile?.role ?? null
        }
        : null
    };
  });

  return res.json({
    logs: hydrated,
    total: Number(count ?? hydrated.length),
    page,
    page_size: pageSize
  });
});

export const adminAuditRouter = router;

