import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();
const IDEMPOTENCY_ROUTE = 'POST /api/sales';

const paymentMethodSchema = z.enum(['cash', 'transfer', 'card', 'mixed', 'trade_in']);

const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(6)
});

const paymentLegacySchema = z.object({
  method: paymentMethodSchema.optional(),
  card_brand: z.string().nullable().optional(),
  installments: z.coerce.number().int().positive().nullable().optional(),
  surcharge_pct: z.coerce.number().min(0).nullable().optional(),
  deposit_ars: z.coerce.number().min(0).nullable().optional(),
  total_ars: z.coerce.number().positive().optional()
});

const saleItemSchema = z.object({
  stock_item_id: z.string().uuid(),
  qty: z.coerce.number().int().min(1).default(1),
  sale_price_ars: z.coerce.number().positive()
});

const tradeInSchema = z.object({
  enabled: z.boolean(),
  device: z.object({
    brand: z.string().min(1),
    model: z.string().min(1),
    storage_gb: z.coerce.number().int().positive().optional(),
    color: z.string().optional(),
    condition: z.string().optional(),
    imei: z.string().optional()
  }),
  trade_value_usd: z.coerce.number().min(0),
  fx_rate_used: z.coerce.number().min(0)
});

const saleCreateSchema = z.object({
  sale_date: z.string().datetime(),
  customer: customerSchema.optional(),
  customer_id: z.string().uuid().optional(),
  payment_method: paymentMethodSchema.optional(),
  card_brand: z.string().nullable().optional(),
  installments: z.coerce.number().int().positive().nullable().optional(),
  surcharge_pct: z.coerce.number().min(0).nullable().optional(),
  deposit_ars: z.coerce.number().min(0).nullable().optional(),
  total_ars: z.coerce.number().positive().optional(),
  items: z.array(saleItemSchema).min(1),
  payment: paymentLegacySchema.optional(),
  trade_in: tradeInSchema.optional()
}).superRefine((value, ctx) => {
  if (!value.customer_id && !value.customer) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'customer_or_customer_id_required',
      path: ['customer']
    });
  }

  const seen = new Set<string>();
  for (const item of value.items) {
    if (seen.has(item.stock_item_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate_stock_item_id',
        path: ['items']
      });
      break;
    }
    seen.add(item.stock_item_id);
  }
});

const salePatchSchema = z.object({
  sale_date: z.string().datetime().optional(),
  customer: customerSchema.optional(),
  customer_id: z.string().uuid().optional(),
  payment_method: paymentMethodSchema.optional(),
  card_brand: z.string().nullable().optional(),
  installments: z.coerce.number().int().positive().nullable().optional(),
  surcharge_pct: z.coerce.number().min(0).nullable().optional(),
  deposit_ars: z.coerce.number().min(0).nullable().optional(),
  total_ars: z.coerce.number().positive().optional(),
  items: z.array(saleItemSchema).min(1).optional(),
  payment: paymentLegacySchema.partial().optional()
}).superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'empty_patch_payload',
      path: []
    });
  }

  if (value.items) {
    const seen = new Set<string>();
    for (const item of value.items) {
      if (seen.has(item.stock_item_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'duplicate_stock_item_id',
          path: ['items']
        });
        break;
      }
      seen.add(item.stock_item_id);
    }
  }
});

const cancelSchema = z.object({
  reason: z.string().trim().min(3).max(500)
});

type SaleItemInput = {
  stock_item_id: string;
  qty: number;
  sale_price_ars: number;
};

type NormalizedCreatePayload = {
  sale_date: string;
  customer?: { name: string; phone: string };
  customer_id?: string;
  payment_method: z.infer<typeof paymentMethodSchema>;
  card_brand: string | null;
  installments: number | null;
  surcharge_pct: number | null;
  deposit_ars: number | null;
  total_ars: number;
  input_total_ars: number | null;
  items: SaleItemInput[];
  payment?: z.infer<typeof paymentLegacySchema>;
  trade_in?: z.infer<typeof tradeInSchema>;
};

type NormalizedPatchPayload = {
  sale_date?: string;
  customer?: { name: string; phone: string };
  customer_id?: string;
  payment_method?: z.infer<typeof paymentMethodSchema>;
  card_brand?: string | null;
  installments?: number | null;
  surcharge_pct?: number | null;
  deposit_ars?: number | null;
  total_ars?: number;
  input_total_ars?: number | null;
  items?: SaleItemInput[];
};

type RpcLikeError = {
  message?: string;
  details?: string;
  code?: string;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function buildItems(items: z.infer<typeof saleItemSchema>[]): SaleItemInput[] {
  return items.map((item) => ({
    stock_item_id: item.stock_item_id,
    qty: item.qty,
    sale_price_ars: item.sale_price_ars
  }));
}

function computeServerTotal(items: SaleItemInput[]): number {
  return items.reduce((sum, item) => sum + (item.qty * item.sale_price_ars), 0);
}

function normalizeCreatePayload(input: z.infer<typeof saleCreateSchema>): NormalizedCreatePayload {
  const paymentMethod = input.payment_method ?? input.payment?.method ?? 'cash';
  const cardBrand = input.card_brand ?? input.payment?.card_brand ?? null;
  const installments = input.installments ?? input.payment?.installments ?? null;
  const surchargePct = input.surcharge_pct ?? input.payment?.surcharge_pct ?? null;
  const depositArs = input.deposit_ars ?? input.payment?.deposit_ars ?? null;
  const inputTotal = input.total_ars ?? input.payment?.total_ars ?? null;
  const items = buildItems(input.items);
  const serverTotal = computeServerTotal(items);

  return {
    sale_date: input.sale_date,
    customer: input.customer,
    customer_id: input.customer_id,
    payment_method: paymentMethod,
    card_brand: cardBrand,
    installments,
    surcharge_pct: surchargePct,
    deposit_ars: depositArs,
    total_ars: serverTotal,
    input_total_ars: inputTotal,
    items,
    payment: input.payment,
    trade_in: input.trade_in
  };
}

function normalizePatchPayload(input: z.infer<typeof salePatchSchema>): NormalizedPatchPayload {
  const payload: NormalizedPatchPayload = {};

  if (input.sale_date !== undefined) payload.sale_date = input.sale_date;
  if (input.customer !== undefined) payload.customer = input.customer;
  if (input.customer_id !== undefined) payload.customer_id = input.customer_id;

  const paymentMethod = input.payment_method ?? input.payment?.method;
  const cardBrand = input.card_brand ?? input.payment?.card_brand;
  const installments = input.installments ?? input.payment?.installments;
  const surchargePct = input.surcharge_pct ?? input.payment?.surcharge_pct;
  const depositArs = input.deposit_ars ?? input.payment?.deposit_ars;
  const inputTotal = input.total_ars ?? input.payment?.total_ars;

  if (paymentMethod !== undefined) payload.payment_method = paymentMethod;
  if (cardBrand !== undefined) payload.card_brand = cardBrand;
  if (installments !== undefined) payload.installments = installments;
  if (surchargePct !== undefined) payload.surcharge_pct = surchargePct;
  if (depositArs !== undefined) payload.deposit_ars = depositArs;
  if (inputTotal !== undefined) {
    payload.total_ars = inputTotal;
    payload.input_total_ars = inputTotal;
  }

  if (input.items !== undefined) {
    payload.items = buildItems(input.items);
  }

  return payload;
}

function mapRpcError(error: RpcLikeError): { status: number; code: string; message: string } {
  const message = (error.message ?? 'rpc_failed').toLowerCase();

  if (message.includes('total_mismatch')) {
    return { status: 422, code: 'total_mismatch', message: 'Provided total_ars does not match server total' };
  }
  if (message.includes('not_found')) {
    return { status: 404, code: 'not_found', message: 'Resource not found' };
  }
  if (message.includes('stock_unavailable') || message.includes('conflict')) {
    return { status: 409, code: 'conflict', message: 'Resource conflict' };
  }
  if (message.includes('validation_error')) {
    return { status: 422, code: 'validation_error', message: 'Validation failed' };
  }

  return { status: 400, code: 'rpc_failed', message: 'Operation failed' };
}

async function persistIdempotencyResult(idempotencyId: string | null, status: number, body: unknown): Promise<void> {
  if (!idempotencyId) return;

  await supabaseAdmin
    .from('idempotency_keys')
    .update({
      response_status: status,
      response_body: body
    })
    .eq('id', idempotencyId);
}

function makeError(code: string, message: string, details?: unknown) {
  return { error: { code, message, details } };
}

router.get('/', requireRole('admin', 'seller'), async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('sales')
    .select('*, customers(name, phone), sale_items(stock_item_id, qty, sale_price_ars, subtotal_ars, stock_items(model, imei))')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(400).json(makeError('sales_fetch_failed', 'Sales fetch failed', error.message));
  }

  const rows = (data ?? []).flatMap((sale) => {
    const items = sale.sale_items ?? [];
    const customerName = sale.customers?.name ?? null;
    const customerPhone = sale.customers?.phone ?? null;

    if (items.length === 0) {
      return [{
        ...sale,
        stock_item_id: null,
        stock_model: null,
        stock_imei: null,
        qty: null,
        sale_price_ars_item: null,
        subtotal_ars_item: null,
        customer_name: customerName,
        customer_phone: customerPhone
      }];
    }

    return items.map((item: {
      stock_item_id: string;
      qty: number | null;
      sale_price_ars: number | null;
      subtotal_ars: number | null;
      stock_items?: { model: string | null; imei: string | null };
    }) => ({
      ...sale,
      stock_item_id: item.stock_item_id,
      stock_model: item.stock_items?.model ?? null,
      stock_imei: item.stock_items?.imei ?? null,
      qty: item.qty,
      sale_price_ars_item: item.sale_price_ars,
      subtotal_ars_item: item.subtotal_ars,
      customer_name: customerName,
      customer_phone: customerPhone
    }));
  });

  return res.json({ sales: rows });
});

router.get('/:id', requireRole('admin', 'seller'), async (req, res) => {
  const saleId = req.params.id;

  const { data: sale, error: saleError } = await supabaseAdmin
    .from('sales')
    .select('*, customers(name, phone), sale_items(*, stock_items(*)), trade_ins(*)')
    .eq('id', saleId)
    .single();

  if (saleError || !sale) {
    return res.status(404).json(makeError('not_found', 'Sale not found', saleError?.message));
  }

  const { data: auditLogs } = await supabaseAdmin
    .from('sale_audit_logs')
    .select('id, action, actor_user_id, reason, payload, created_at')
    .eq('sale_id', saleId)
    .order('created_at', { ascending: false });

  return res.json({
    sale: {
      ...sale,
      audit_logs: auditLogs ?? []
    }
  });
});

router.post('/', requireRole('admin', 'seller'), async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json(makeError('unauthorized', 'Missing authenticated user'));
  }

  const parsed = saleCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(makeError('validation_error', 'Invalid sale payload', parsed.error.flatten()));
  }

  const normalized = normalizeCreatePayload(parsed.data);
  if (normalized.input_total_ars != null && Math.abs(normalized.input_total_ars - normalized.total_ars) > 0.01) {
    return res.status(422).json(makeError('total_mismatch', 'Provided total_ars does not match server total', {
      input_total_ars: normalized.input_total_ars,
      server_total_ars: normalized.total_ars
    }));
  }

  const idempotencyKey = req.header('x-idempotency-key')?.trim();
  const requestHash = hashPayload(normalized);
  let idempotencyId: string | null = null;

  if (idempotencyKey) {
    const findExisting = async () => supabaseAdmin
      .from('idempotency_keys')
      .select('id, request_hash, response_status, response_body')
      .eq('user_id', userId)
      .eq('route', IDEMPOTENCY_ROUTE)
      .eq('key', idempotencyKey)
      .maybeSingle();

    const { data: existing, error: existingError } = await findExisting();
    if (existingError) {
      return res.status(400).json(makeError('idempotency_lookup_failed', 'Failed to lookup idempotency key', existingError.message));
    }

    if (existing) {
      if (existing.request_hash !== requestHash) {
        return res.status(409).json(makeError('idempotency_conflict', 'Same idempotency key used with different payload'));
      }

      if (existing.response_status && existing.response_body) {
        return res.status(existing.response_status).json(existing.response_body);
      }

      return res.status(409).json(makeError('idempotency_in_progress', 'Request with this idempotency key is in progress'));
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('idempotency_keys')
      .insert({
        user_id: userId,
        route: IDEMPOTENCY_ROUTE,
        key: idempotencyKey,
        request_hash: requestHash,
        expires_at: expiresAt
      })
      .select('id')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        const { data: raced, error: racedError } = await findExisting();
        if (racedError) {
          return res.status(400).json(makeError('idempotency_lookup_failed', 'Failed to lookup idempotency key', racedError.message));
        }
        if (raced) {
          if (raced.request_hash !== requestHash) {
            return res.status(409).json(makeError('idempotency_conflict', 'Same idempotency key used with different payload'));
          }
          if (raced.response_status && raced.response_body) {
            return res.status(raced.response_status).json(raced.response_body);
          }
          return res.status(409).json(makeError('idempotency_in_progress', 'Request with this idempotency key is in progress'));
        }
      }

      return res.status(400).json(makeError('idempotency_reserve_failed', 'Failed to reserve idempotency key', insertError.message));
    }

    idempotencyId = inserted?.id ?? null;
  }

  const rpcPayload = {
    ...normalized,
    total_ars: normalized.total_ars
  };

  const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('rpc_create_sale_v2', {
    p_payload: rpcPayload,
    p_user_id: userId
  });

  if (rpcError) {
    const mapped = mapRpcError(rpcError);
    const body = makeError(mapped.code, mapped.message, rpcError.details ?? rpcError.message);
    await persistIdempotencyResult(idempotencyId, mapped.status, body);
    return res.status(mapped.status).json(body);
  }

  const responseBody = {
    sale_id: rpcData?.sale_id,
    trade_in_id: rpcData?.trade_in_id ?? null,
    customer_id: rpcData?.customer_id,
    total_ars: Number(rpcData?.total_ars ?? normalized.total_ars),
    server_total_ars: Number(rpcData?.server_total_ars ?? normalized.total_ars)
  };

  await persistIdempotencyResult(idempotencyId, 201, responseBody);
  return res.status(201).json(responseBody);
});

router.patch('/:id', requireRole('admin', 'seller'), async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json(makeError('unauthorized', 'Missing authenticated user'));
  }

  const parsed = salePatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(makeError('validation_error', 'Invalid patch payload', parsed.error.flatten()));
  }

  const normalized = normalizePatchPayload(parsed.data);

  if (normalized.items && normalized.total_ars != null) {
    const serverTotal = computeServerTotal(normalized.items);
    if (Math.abs(serverTotal - normalized.total_ars) > 0.01) {
      return res.status(422).json(makeError('total_mismatch', 'Provided total_ars does not match server total', {
        input_total_ars: normalized.total_ars,
        server_total_ars: serverTotal
      }));
    }
  }

  const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('rpc_update_sale_v2', {
    p_sale_id: req.params.id,
    p_payload: normalized,
    p_user_id: userId
  });

  if (rpcError) {
    const mapped = mapRpcError(rpcError);
    return res.status(mapped.status).json(makeError(mapped.code, mapped.message, rpcError.details ?? rpcError.message));
  }

  return res.json({
    sale_id: rpcData?.sale_id,
    customer_id: rpcData?.customer_id,
    total_ars: Number(rpcData?.total_ars ?? 0),
    server_total_ars: Number(rpcData?.server_total_ars ?? 0),
    status: rpcData?.status ?? 'completed'
  });
});

router.post('/:id/cancel', requireRole('admin', 'seller'), async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json(makeError('unauthorized', 'Missing authenticated user'));
  }

  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(makeError('validation_error', 'Invalid cancel payload', parsed.error.flatten()));
  }

  const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('rpc_cancel_sale_v2', {
    p_sale_id: req.params.id,
    p_reason: parsed.data.reason,
    p_user_id: userId
  });

  if (rpcError) {
    const mapped = mapRpcError(rpcError);
    return res.status(mapped.status).json(makeError(mapped.code, mapped.message, rpcError.details ?? rpcError.message));
  }

  return res.json({
    sale_id: rpcData?.sale_id,
    status: rpcData?.status ?? 'cancelled'
  });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json(makeError('unauthorized', 'Missing authenticated user'));
  }

  const { error: rpcError } = await supabaseAdmin.rpc('rpc_cancel_sale_v2', {
    p_sale_id: req.params.id,
    p_reason: 'legacy_delete_endpoint',
    p_user_id: userId
  });

  if (rpcError) {
    const mapped = mapRpcError(rpcError);
    if (mapped.status === 404) {
      return res.status(404).json(makeError('not_found', 'Sale not found'));
    }
    return res.status(mapped.status).json(makeError(mapped.code, mapped.message, rpcError.details ?? rpcError.message));
  }

  return res.status(204).send();
});

export const salesRouter = router;
