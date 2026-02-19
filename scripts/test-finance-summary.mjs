import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

function fail(message, details) {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, message, details }, null, 2));
  process.exit(1);
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
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

const { data: latestCompletedSale, error: latestSaleError } = await supabase
  .from('sales')
  .select('sale_date')
  .eq('status', 'completed')
  .order('sale_date', { ascending: false })
  .limit(1)
  .maybeSingle();

assert(!latestSaleError, 'Failed to query completed sales for happy range', latestSaleError?.message);
assert(Boolean(latestCompletedSale?.sale_date), 'No completed sales found; cannot run happy-case summary test', latestCompletedSale);

const happyDate = String(latestCompletedSale.sale_date).slice(0, 10);
const noDataFrom = '2099-01-01';
const noDataTo = '2099-01-02';

const happySummary = await fetchJson(`${baseUrl}/api/finance/summary?from=${happyDate}&to=${happyDate}`, {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${adminToken}`
  }
});

assert(happySummary.status === 200, 'Expected 200 on finance summary happy case', happySummary);
assert(!happySummary.body?.error, 'Expected no error body in happy case', happySummary.body);
assert(isNumber(happySummary.body?.sales_total), 'sales_total must be number', happySummary.body);
assert(isNumber(happySummary.body?.sales_count), 'sales_count must be number', happySummary.body);
assert(isNumber(happySummary.body?.margin_total), 'margin_total must be number', happySummary.body);
assert(isNumber(happySummary.body?.ticket_avg), 'ticket_avg must be number', happySummary.body);
assert(Array.isArray(happySummary.body?.payment_mix), 'payment_mix must be an array', happySummary.body);
assert((happySummary.body?.sales_count ?? 0) >= 1, 'Expected at least one sale in happy case range', happySummary.body);

const noDataSummary = await fetchJson(`${baseUrl}/api/finance/summary?from=${noDataFrom}&to=${noDataTo}`, {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${adminToken}`
  }
});

assert(noDataSummary.status === 200, 'Expected 200 on no-data range', noDataSummary);
assert(Number(noDataSummary.body?.sales_total ?? NaN) === 0, 'Expected sales_total=0 on no-data range', noDataSummary.body);
assert(Number(noDataSummary.body?.sales_count ?? NaN) === 0, 'Expected sales_count=0 on no-data range', noDataSummary.body);
assert(Number(noDataSummary.body?.margin_total ?? NaN) === 0, 'Expected margin_total=0 on no-data range', noDataSummary.body);
assert(Number(noDataSummary.body?.ticket_avg ?? NaN) === 0, 'Expected ticket_avg=0 on no-data range', noDataSummary.body);
assert(Array.isArray(noDataSummary.body?.payment_mix) && noDataSummary.body.payment_mix.length === 0, 'Expected empty payment_mix on no-data range', noDataSummary.body);

const regressionSummary = await fetchJson(`${baseUrl}/api/finance/summary?from=${happyDate}&to=${happyDate}`, {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${adminToken}`
  }
});

assert(regressionSummary.status === 200, 'Expected 200 on regression check', regressionSummary);
const regressionBodyText = JSON.stringify(regressionSummary.body ?? {}).toLowerCase();
assert(!regressionBodyText.includes('could not embed because more than one relationship was found'), 'Regression: ambiguous embed error reappeared', regressionSummary.body);

// eslint-disable-next-line no-console
console.log(JSON.stringify({
  ok: true,
  checks: {
    happy_status: happySummary.status,
    no_data_status: noDataSummary.status,
    regression_status: regressionSummary.status,
    fk_ambiguity_error_present: false,
    happy_sales_count: happySummary.body?.sales_count ?? null,
    no_data_sales_count: noDataSummary.body?.sales_count ?? null,
    happy_date: happyDate
  }
}, null, 2));
