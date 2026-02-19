import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  // eslint-disable-next-line no-console
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function assert(condition, message, details = null) {
  if (!condition) {
    throw new Error(`${message}${details ? ` | ${JSON.stringify(details)}` : ''}`);
  }
}

async function requestJson(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
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

async function login(email, password) {
  const result = await requestJson('/api/auth/login', {
    method: 'POST',
    body: { email, password }
  });
  assert(result.status === 200, 'login_failed', result);
  assert(Boolean(result.body?.access_token), 'missing_access_token', result);
  return {
    token: result.body.access_token,
    userId: result.body.user?.id ?? null
  };
}

async function main() {
  const report = {
    happy_sale: null,
    stock_conflict: null,
    rollback_sale_items: null,
    owner_protected: null,
    self_demotion: null
  };

  let createdSaleId = null;
  let tempOwnerUserId = null;

  try {
    const adminAuth = await login('mocho@gmail.com', '123456');
    const adminToken = adminAuth.token;
    const adminUserId = adminAuth.userId;
    assert(Boolean(adminUserId), 'admin_user_id_missing');

    const { data: adminProfile, error: adminProfileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', adminUserId)
      .maybeSingle();

    assert(!adminProfileError, 'admin_profile_query_failed', adminProfileError?.message);
    assert(adminProfile?.role === 'admin' || adminProfile?.role === 'owner', 'admin_profile_role_invalid', adminProfile);

    const tempOwnerEmail = `owner-test-${Date.now()}@example.com`;
    const tempOwnerPassword = 'OwnerTest123!';
    const { data: ownerAuthData, error: ownerAuthError } = await supabase.auth.admin.createUser({
      email: tempOwnerEmail,
      password: tempOwnerPassword,
      email_confirm: true
    });
    assert(!ownerAuthError && ownerAuthData?.user?.id, 'temp_owner_auth_create_failed', ownerAuthError?.message);
    tempOwnerUserId = ownerAuthData.user.id;

    const upsertOwnerProfilePayloads = [
      { id: tempOwnerUserId, email: tempOwnerEmail, full_name: 'Owner Temp', role: 'owner' },
      { id: tempOwnerUserId, full_name: 'Owner Temp', role: 'owner' }
    ];
    let ownerProfileUpserted = false;
    let ownerProfileUpsertError = null;
    for (const payload of upsertOwnerProfilePayloads) {
      const { error } = await supabase
        .from('profiles')
        .upsert(payload, { onConflict: 'id' });
      if (!error) {
        ownerProfileUpserted = true;
        break;
      }
      ownerProfileUpsertError = error.message;
    }
    assert(ownerProfileUpserted, 'temp_owner_profile_upsert_failed', ownerProfileUpsertError);

    const ownerPatchResult = await requestJson(`/api/admin/users/${tempOwnerUserId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'seller' }
    });
    assert(ownerPatchResult.status === 409, 'owner_role_patch_should_be_409', ownerPatchResult);
    assert(ownerPatchResult.body?.error?.code === 'protected_role', 'owner_role_patch_code_invalid', ownerPatchResult);
    report.owner_protected = ownerPatchResult;

    const selfTargetRole = adminProfile.role === 'owner' ? 'admin' : 'seller';
    const selfDemotionResult = await requestJson(`/api/admin/users/${adminUserId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: selfTargetRole }
    });
    assert(selfDemotionResult.status === 403, 'self_demotion_should_be_403', selfDemotionResult);
    assert(selfDemotionResult.body?.error?.code === 'forbidden_role_change', 'self_demotion_code_invalid', selfDemotionResult);
    report.self_demotion = selfDemotionResult;

    const { data: availableItems, error: availableItemsError } = await supabase
      .from('stock_items')
      .select('id,status')
      .eq('status', 'available')
      .limit(2);
    assert(!availableItemsError, 'available_items_query_failed', availableItemsError?.message);
    assert((availableItems ?? []).length >= 2, 'not_enough_available_items_for_tests', availableItems);

    const [happyItem, rollbackItem] = availableItems;
    const happyNote = `test-happy-${Date.now()}`;
    const happyPayload = {
      sale_date: new Date().toISOString(),
      customer: { name: 'Test Happy', phone: `3816${String(Date.now()).slice(-6)}` },
      payment_method: 'cash',
      currency: 'ARS',
      total_ars: 1200,
      notes: happyNote,
      items: [{ stock_item_id: happyItem.id, qty: 1, sale_price_ars: 1200 }]
    };

    const happyResult = await requestJson('/api/sales', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': `happy-${Date.now()}` },
      body: happyPayload
    });
    assert(happyResult.status === 201, 'happy_sale_should_be_201', happyResult);
    assert(happyResult.body?.stock_synced === true, 'happy_sale_stock_synced_missing', happyResult);
    assert(Array.isArray(happyResult.body?.items_applied) && happyResult.body.items_applied.length === 1, 'happy_sale_items_applied_invalid', happyResult);
    createdSaleId = happyResult.body?.sale_id ?? happyResult.body?.sale?.id ?? null;
    assert(Boolean(createdSaleId), 'happy_sale_id_missing', happyResult);

    const { data: happyStock, error: happyStockError } = await supabase
      .from('stock_items')
      .select('status,sale_id')
      .eq('id', happyItem.id)
      .single();
    assert(!happyStockError, 'happy_stock_query_failed', happyStockError?.message);
    assert(happyStock?.status === 'sold', 'happy_stock_not_sold', happyStock);
    assert(happyStock?.sale_id === createdSaleId, 'happy_stock_sale_id_mismatch', { happyStock, createdSaleId });
    report.happy_sale = { status: happyResult.status, sale_id: createdSaleId, stock_status: happyStock.status };

    const conflictNote = `test-conflict-${Date.now()}`;
    const conflictPayload = {
      sale_date: new Date().toISOString(),
      customer: { name: 'Test Conflict', phone: `3815${String(Date.now()).slice(-6)}` },
      payment_method: 'cash',
      currency: 'ARS',
      total_ars: 1200,
      notes: conflictNote,
      items: [{ stock_item_id: happyItem.id, qty: 1, sale_price_ars: 1200 }]
    };
    const conflictResult = await requestJson('/api/sales', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': `conflict-${Date.now()}` },
      body: conflictPayload
    });
    assert(conflictResult.status === 409, 'conflict_sale_should_be_409', conflictResult);
    assert(conflictResult.body?.error?.code === 'stock_conflict', 'conflict_sale_code_invalid', conflictResult);

    const { data: conflictSales, error: conflictSalesError } = await supabase
      .from('sales')
      .select('id')
      .eq('notes', conflictNote);
    assert(!conflictSalesError, 'conflict_sales_query_failed', conflictSalesError?.message);
    assert((conflictSales ?? []).length === 0, 'conflict_should_not_create_sale', conflictSales);
    report.stock_conflict = { status: conflictResult.status, code: conflictResult.body?.error?.code };

    const rollbackNote = `test-rollback-items-${Date.now()}`;
    const rollbackPayload = {
      sale_date: new Date().toISOString(),
      customer: { name: 'Test Rollback', phone: `3814${String(Date.now()).slice(-6)}` },
      payment_method: 'cash',
      currency: 'ARS',
      total_ars: 2400,
      notes: rollbackNote,
      items: [{ stock_item_id: rollbackItem.id, qty: 2, sale_price_ars: 1200 }]
    };
    const rollbackResult = await requestJson('/api/sales', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': `rollback-${Date.now()}` },
      body: rollbackPayload
    });
    assert(rollbackResult.status === 422, 'rollback_sale_should_be_422', rollbackResult);
    assert(rollbackResult.body?.error?.code === 'validation_error', 'rollback_sale_code_invalid', rollbackResult);

    const { data: rollbackSales, error: rollbackSalesError } = await supabase
      .from('sales')
      .select('id')
      .eq('notes', rollbackNote);
    assert(!rollbackSalesError, 'rollback_sales_query_failed', rollbackSalesError?.message);
    assert((rollbackSales ?? []).length === 0, 'rollback_should_not_create_sale', rollbackSales);
    report.rollback_sale_items = { status: rollbackResult.status, code: rollbackResult.body?.error?.code };

    if (createdSaleId) {
      await requestJson(`/api/sales/${createdSaleId}/cancel`, {
        method: 'POST',
        token: adminToken,
        body: { reason: 'test_cleanup' }
      });
    }

    if (tempOwnerUserId) {
      await supabase.auth.admin.deleteUser(tempOwnerUserId);
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, report }, null, 2));
  } catch (error) {
    if (createdSaleId) {
      const adminAuth = await login('mocho@gmail.com', '123456');
      await requestJson(`/api/sales/${createdSaleId}/cancel`, {
        method: 'POST',
        token: adminAuth.token,
        body: { reason: 'test_cleanup_on_error' }
      });
    }

    if (tempOwnerUserId) {
      await supabase.auth.admin.deleteUser(tempOwnerUserId);
    }

    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2));
    process.exit(1);
  }
}

await main();
