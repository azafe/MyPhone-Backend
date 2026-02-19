import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

function fail(message, details) {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, message, details }, null, 2));
  process.exit(1);
}

const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRole) {
  fail('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, serviceRole, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) {
    fail(`Login failed for ${email}`, error?.message ?? 'no_session');
  }
  return data.session.access_token;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const adminToken = await login('mocho@gmail.com', '123456');
const sellerToken = await login('bruno@gmail.com', '123456');

const { data: soldItem, error: soldError } = await supabase
  .from('stock_items')
  .select('id,status')
  .eq('status', 'sold')
  .limit(1)
  .maybeSingle();

if (soldError || !soldItem?.id) {
  fail('No sold stock item found for conflict test', soldError?.message ?? 'not_found');
}

const idempotencyKey = `smoke-lote7-${Date.now()}`;
const payload = {
  sale_date: new Date().toISOString(),
  customer: { name: 'Smoke Test', phone: `3817${String(Date.now()).slice(-6)}` },
  payment_method: 'cash',
  currency: 'ARS',
  total_ars: 1000,
  items: [{ stock_item_id: soldItem.id, qty: 1, sale_price_ars: 1000 }]
};

const first = await fetchJson(`${baseUrl}/api/sales/checkout`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey
  },
  body: JSON.stringify(payload)
});

const second = await fetchJson(`${baseUrl}/api/sales/checkout`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey
  },
  body: JSON.stringify(payload)
});

if (first.status !== 409 || second.status !== 409) {
  fail('Expected 409 stock conflict for checkout retry', { first, second });
}

if (first.body?.error?.code !== 'stock_conflict' || second.body?.error?.code !== 'stock_conflict') {
  fail('Expected stock_conflict code on checkout retry', { first, second });
}

const today = new Date().toISOString().slice(0, 10);
const financeSeller = await fetchJson(`${baseUrl}/api/finance/accounts-receivable?from=${today}&to=${today}`, {
  method: 'GET',
  headers: { Authorization: `Bearer ${sellerToken}` }
});
if (financeSeller.status !== 403) {
  fail('Expected seller to be forbidden on /api/finance/accounts-receivable', financeSeller);
}

const financeAdmin = await fetchJson(`${baseUrl}/api/finance/accounts-receivable?from=${today}&to=${today}`, {
  method: 'GET',
  headers: { Authorization: `Bearer ${adminToken}` }
});
if (financeAdmin.status !== 200) {
  fail('Expected admin access to /api/finance/accounts-receivable', financeAdmin);
}

// eslint-disable-next-line no-console
console.log(JSON.stringify({
  ok: true,
  checks: {
    checkout_conflict_status: [first.status, second.status],
    checkout_conflict_code: [first.body?.error?.code, second.body?.error?.code],
    finance_seller_status: financeSeller.status,
    finance_admin_status: financeAdmin.status
  }
}, null, 2));
