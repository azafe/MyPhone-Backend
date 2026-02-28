import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { requireRole } from '../../middleware/rbac.js';

const router = Router();

const conditionEnum = z.enum(['new', 'like_new', 'used', 'outlet']);
const statusEnum = z.enum(['available', 'reserved', 'sold', 'service_tech', 'drawer']);
const categoryEnum = z.enum(['used_premium', 'outlet', 'new']);
const sortByEnum = z.enum(['received_at', 'created_at', 'updated_at', 'sale_price_ars', 'model', 'status']);
const sortDirEnum = z.enum(['asc', 'desc']);
const SALE_ITEMS_TO_SALES_FK_CANDIDATES = [
  'sale_items_sale_id_fk',
  'sale_items_sale_id_fkey'
] as const;

type RestError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

type SaleHistoryRow = {
  id: string;
  sale_id: string;
  stock_item_id: string;
  qty: number | null;
  sale_price_ars: number | null;
  subtotal_ars: number | null;
  sales?:
    | {
      id: string;
      sale_date: string | null;
      created_at: string | null;
      status: string | null;
      total_ars: number | null;
      payment_method: string | null;
      customers?:
        | {
          name: string | null;
          phone: string | null;
        }
        | Array<{
          name: string | null;
          phone: string | null;
        }>
        | null;
    }
    | Array<{
      id: string;
      sale_date: string | null;
      created_at: string | null;
      status: string | null;
      total_ars: number | null;
      payment_method: string | null;
      customers?:
        | {
          name: string | null;
          phone: string | null;
        }
        | Array<{
          name: string | null;
          phone: string | null;
        }>
        | null;
    }>
    | null;
};

function normalizeLikeValue(raw: string): string {
  return raw.trim().replaceAll(',', ' ').replaceAll('%', '').replaceAll('*', '').replaceAll('_', '');
}

function parseStatuses(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const statuses = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (statuses.length === 0) return undefined;
  return statuses;
}

function toMillis(value?: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchSaleHistoryRows(stockItemId: string) {
  let lastError: RestError | null = null;

  for (const salesFkName of SALE_ITEMS_TO_SALES_FK_CANDIDATES) {
    const { data, error } = await supabaseAdmin
      .from('sale_items')
      .select(`id, sale_id, stock_item_id, qty, sale_price_ars, subtotal_ars, sales!${salesFkName}(id, sale_date, created_at, status, total_ars, payment_method, customers(name, phone))`)
      .eq('stock_item_id', stockItemId);

    if (!error) {
      return { data: (data ?? []) as SaleHistoryRow[], fkName: salesFkName, error: null as RestError | null };
    }

    lastError = error;
    const relationMissing = error.code === 'PGRST200' || error.code === 'PGRST201';
    if (!relationMissing) {
      break;
    }
  }

  return { data: null as SaleHistoryRow[] | null, fkName: null as string | null, error: lastError };
}

function mapStockError(error: RestError, fallbackCode: string, fallbackMessage: string) {
  const message = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase();
  if (error.code === '23505' && message.includes('imei')) {
    return {
      status: 409,
      code: 'imei_conflict',
      message: 'IMEI already exists',
      details: error.details ?? error.message
    };
  }

  if (message.includes('stock_conflict')) {
    return {
      status: 409,
      code: 'stock_conflict',
      message: 'Stock conflict',
      details: error.details ?? error.message
    };
  }

  if (error.code === 'PGRST116') {
    return {
      status: 404,
      code: 'not_found',
      message: 'Stock item not found',
      details: error.details ?? error.message
    };
  }

  return {
    status: 400,
    code: fallbackCode,
    message: fallbackMessage,
    details: error.details ?? error.message
  };
}

function logValidationError(details: unknown): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    level: 'warn',
    event: 'validation_error',
    scope: 'stock-items.create',
    details,
    timestamp: new Date().toISOString()
  }));
}

const createSchema = z
  .object({
    brand: z.string().min(1),
    model: z.string().min(1),
    condition: conditionEnum,
    category: categoryEnum,
    sale_price_ars: z.number().min(0),
    sale_price_usd: z.number().min(0).nullable().optional(),
    purchase_usd: z.number().min(0).nullable().optional(),
    fx_rate_used: z.number().min(0).nullable().optional(),
    purchase_ars: z.number().min(0).nullable().optional(),
    warranty_days: z.number().int().positive().nullable().optional(),
    battery_pct: z.number().int().min(0).max(100).nullable().optional(),
    storage_gb: z.number().int().positive().nullable().optional(),
    color: z.string().nullable().optional(),
    color_other: z.string().nullable().optional(),
    imei: z.string().trim().min(1),
    provider_name: z.string().min(1).nullable().optional(),
    details: z.string().nullable().optional(),
    received_at: z.string().datetime().nullable().optional(),
    is_promo: z.boolean().optional(),
    is_sealed: z.boolean().optional(),
    notes: z.string().nullable().optional(),
    status: statusEnum.optional()
  })
  .refine(
    (data) =>
      data.purchase_ars != null ||
      (data.purchase_usd != null && data.fx_rate_used != null),
    { message: 'purchase_ars or (purchase_usd + fx_rate_used) required' }
  );

const listSchema = z.object({
  status: statusEnum.optional(),
  statuses: z.string().optional(),
  category: categoryEnum.optional(),
  model: z.string().optional(),
  storage_gb: z.coerce.number().int().positive().optional(),
  battery_min: z.coerce.number().int().min(0).max(100).optional(),
  battery_max: z.coerce.number().int().min(0).max(100).optional(),
  promo: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((value) => (value == null ? undefined : value === 'true')),
  provider: z.string().optional(),
  query: z.string().optional(),
  condition: conditionEnum.optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  page_size: z.coerce.number().int().positive().max(200).optional().default(40),
  sort_by: sortByEnum.optional().default('received_at'),
  sort_dir: sortDirEnum.optional().default('desc')
}).superRefine((value, ctx) => {
  if (value.battery_min != null && value.battery_max != null && value.battery_min > value.battery_max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'battery_min cannot be greater than battery_max',
      path: ['battery_min']
    });
  }
});

const patchSchema = z
  .object({
    brand: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    condition: conditionEnum.optional(),
    category: categoryEnum.optional().nullable(),
    sale_price_ars: z.number().min(0).optional(),
    sale_price_usd: z.number().min(0).nullable().optional(),
    purchase_usd: z.number().min(0).nullable().optional(),
    fx_rate_used: z.number().min(0).nullable().optional(),
    purchase_ars: z.number().min(0).nullable().optional(),
    warranty_days: z.number().int().positive().nullable().optional(),
    battery_pct: z.number().int().min(0).max(100).nullable().optional(),
    storage_gb: z.number().int().positive().nullable().optional(),
    color: z.string().nullable().optional(),
    color_other: z.string().nullable().optional(),
    imei: z.string().trim().min(1).optional(),
    provider_name: z.string().min(1).nullable().optional(),
    details: z.string().nullable().optional(),
    received_at: z.string().datetime().nullable().optional(),
    is_promo: z.boolean().optional(),
    is_sealed: z.boolean().optional(),
    notes: z.string().nullable().optional(),
    status: statusEnum.optional()
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'empty_patch_payload',
        path: []
      });
    }

    if (
      value.purchase_ars == null &&
      ((value.purchase_usd != null && value.fx_rate_used == null) || (value.purchase_usd == null && value.fx_rate_used != null))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'purchase_ars or (purchase_usd + fx_rate_used) required',
        path: ['purchase_ars']
      });
    }
  });

router.get('/', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    logValidationError(parsed.error.flatten());
    return res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid stock list query', details: parsed.error.flatten() }
    });
  }

  const params = parsed.data;
  const statuses = parseStatuses(params.statuses);
  const page = params.page ?? 1;
  const pageSize = params.page_size ?? 40;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from('stock_items')
    .select('*', { count: 'exact' });

  if (params.status) query = query.eq('status', params.status);
  if (statuses && statuses.length > 0) query = query.in('status', statuses);
  if (params.category) query = query.eq('category', params.category);
  if (params.model) query = query.ilike('model', `%${normalizeLikeValue(params.model)}%`);
  if (params.storage_gb != null) query = query.eq('storage_gb', params.storage_gb);
  if (params.battery_min != null) query = query.gte('battery_pct', params.battery_min);
  if (params.battery_max != null) query = query.lte('battery_pct', params.battery_max);
  if (params.promo != null) query = query.eq('is_promo', params.promo);
  if (params.provider) query = query.ilike('provider_name', `%${normalizeLikeValue(params.provider)}%`);
  if (params.condition) query = query.eq('condition', params.condition);
  if (params.query) {
    const search = normalizeLikeValue(params.query);
    query = query.or(`model.ilike.%${search}%,imei.ilike.%${search}%,provider_name.ilike.%${search}%,details.ilike.%${search}%`);
  }

  const { data, error, count } = await query
    .order(params.sort_by ?? 'received_at', { ascending: (params.sort_dir ?? 'desc') === 'asc', nullsFirst: false })
    .range(from, to);

  if (error) {
    const mapped = mapStockError(error, 'stock_fetch_failed', 'Fetch failed');
    return res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, details: mapped.details }
    });
  }

  return res.json({
    items: data ?? [],
    total: Number(count ?? (data?.length ?? 0)),
    page,
    page_size: pageSize
  });
});

router.get('/imei/:imei/history', requireRole('admin', 'seller'), async (req, res) => {
  const imei = req.params.imei?.trim();
  if (!imei) {
    return res.status(400).json({
      error: { code: 'validation_error', message: 'IMEI required' }
    });
  }

  const { data: stockItem, error: stockError } = await supabaseAdmin
    .from('stock_items')
    .select('*')
    .eq('imei', imei)
    .maybeSingle();

  if (stockError) {
    const mapped = mapStockError(stockError, 'stock_fetch_failed', 'Fetch failed');
    return res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, details: mapped.details }
    });
  }

  if (!stockItem) {
    return res.status(404).json({
      error: { code: 'not_found', message: 'Stock item not found for IMEI' }
    });
  }

  const { data: historyRows, error: historyError } = await fetchSaleHistoryRows(stockItem.id);
  if (historyError) {
    return res.status(400).json({
      error: {
        code: 'stock_history_fetch_failed',
        message: 'Could not fetch IMEI history',
        details: [historyError.code, historyError.message, historyError.hint].filter(Boolean).join(' | ')
      }
    });
  }

  const sales = (historyRows ?? [])
    .map((row) => {
      const sale = Array.isArray(row.sales) ? row.sales[0] : row.sales;
      const customerRaw = sale?.customers;
      const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;

      return {
        sale_item_id: row.id,
        sale_id: row.sale_id,
        sale_date: sale?.sale_date ?? sale?.created_at ?? null,
        sale_status: sale?.status ?? null,
        sale_total_ars: sale?.total_ars ?? null,
        payment_method: sale?.payment_method ?? null,
        qty: row.qty,
        sale_price_ars: row.sale_price_ars,
        subtotal_ars: row.subtotal_ars,
        customer_name: customer?.name ?? null,
        customer_phone: customer?.phone ?? null
      };
    })
    .sort((a, b) => toMillis(b.sale_date) - toMillis(a.sale_date));

  return res.json({
    imei,
    stock_item: stockItem,
    sales,
    sales_count: sales.length
  });
});

router.get('/:id', requireRole('admin', 'seller'), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('stock_items')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    const mapped = mapStockError(error ?? {}, 'not_found', 'Stock item not found');
    return res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, details: mapped.details }
    });
  }

  return res.json(data);
});

router.post('/', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    logValidationError(parsed.error.flatten());
    return res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid stock item payload', details: parsed.error.flatten() }
    });
  }

  const payload = parsed.data;
  const purchase_ars =
    payload.purchase_ars ??
    Number(payload.purchase_usd) * Number(payload.fx_rate_used);

  const insertPayload = {
    brand: payload.brand,
    model: payload.model,
    condition: payload.condition,
    category: payload.category,
    sale_price_ars: payload.sale_price_ars,
    sale_price_usd: payload.sale_price_usd ?? null,
    purchase_usd: payload.purchase_usd ?? null,
    fx_rate_used: payload.fx_rate_used ?? null,
    purchase_ars,
    warranty_days: payload.warranty_days ?? 90,
    battery_pct: payload.battery_pct ?? null,
    storage_gb: payload.storage_gb ?? null,
    color: payload.color ?? null,
    color_other: payload.color_other ?? null,
    imei: payload.imei.trim(),
    provider_name: payload.provider_name ?? null,
    details: payload.details ?? null,
    received_at: payload.received_at ?? null,
    is_promo: payload.is_promo ?? false,
    is_sealed: payload.is_sealed ?? false,
    notes: payload.notes ?? null,
    status: payload.status ?? 'available',
    trade_in_id: null
  };

  const { data, error } = await supabaseAdmin
    .from('stock_items')
    .insert(insertPayload)
    .select('*')
    .single();

  if (error || !data) {
    const mapped = mapStockError(error ?? {}, 'stock_create_failed', 'Insert failed');
    return res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, details: mapped.details }
    });
  }

  return res.status(201).json(data);
});

router.patch('/:id', requireRole('admin', 'seller'), async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    logValidationError(parsed.error.flatten());
    return res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid stock item patch', details: parsed.error.flatten() }
    });
  }

  const payload = { ...parsed.data };
  const normalizedImei = typeof payload.imei === 'string' ? payload.imei.trim() : undefined;
  if (normalizedImei !== undefined) {
    payload.imei = normalizedImei;
  }

  if (payload.purchase_ars == null && payload.purchase_usd != null && payload.fx_rate_used != null) {
    payload.purchase_ars = Number(payload.purchase_usd) * Number(payload.fx_rate_used);
  }

  const { data, error } = await supabaseAdmin
    .from('stock_items')
    .update(payload)
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !data) {
    const mapped = mapStockError(error ?? {}, 'stock_update_failed', 'Update failed');
    return res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, details: mapped.details }
    });
  }

  return res.json(data);
});

export const stockItemsRouter = router;
