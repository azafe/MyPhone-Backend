import 'dotenv/config';

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

const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';

async function fetchJson(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return { status: response.status, body: json };
}

const login = await fetchJson('/api/auth/login', {
  method: 'POST',
  body: { email: 'mocho@gmail.com', password: '123456' }
});

assert(login.status === 200, 'login_failed', login);
assert(Boolean(login.body?.access_token), 'missing_access_token', login);

const token = login.body.access_token;
const today = new Date().toISOString().slice(0, 10);

const sales = await fetchJson('/api/sales', { token });
assert(sales.status === 200, 'sales_list_should_be_200', sales);
assert(Array.isArray(sales.body?.sales), 'sales_list_should_return_sales_array', sales);

const salesBodyText = JSON.stringify(sales.body ?? {}).toLowerCase();
assert(!salesBodyText.includes('could not embed because more than one relationship was found'), 'sales_list_embed_ambiguity_regression', sales.body);

const finance = await fetchJson(`/api/finance/summary?from=${today}&to=${today}`, { token });
assert(finance.status === 200, 'finance_summary_should_stay_200', finance);

const financeBodyText = JSON.stringify(finance.body ?? {}).toLowerCase();
assert(!financeBodyText.includes('could not embed because more than one relationship was found'), 'finance_embed_ambiguity_regression', finance.body);

// eslint-disable-next-line no-console
console.log(JSON.stringify({
  ok: true,
  checks: {
    sales_status: sales.status,
    sales_count: sales.body?.sales?.length ?? null,
    finance_status: finance.status,
    finance_sales_count: finance.body?.sales_count ?? null
  }
}, null, 2));
