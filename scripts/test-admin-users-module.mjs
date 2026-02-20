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

async function login(email, password) {
  const result = await fetchJson('/api/auth/login', {
    method: 'POST',
    body: { email, password }
  });

  assert(result.status === 200, `login_failed_${email}`, result);
  assert(Boolean(result.body?.access_token), `missing_access_token_${email}`, result);

  return {
    token: result.body.access_token,
    userId: result.body?.user?.id ?? null
  };
}

const report = {
  owner_lists: null,
  admin_lists: null,
  seller_blocked: null,
  owner_protected: null,
  role_change_valid: null,
  self_demotion_blocked: null
};

let tempAdminId = null;
let tempSellerId = null;

try {
  const ownerAuth = await login('mocho@gmail.com', '123456');
  const ownerToken = ownerAuth.token;

  const ownerList = await fetchJson('/api/admin/users', { token: ownerToken });
  assert(ownerList.status === 200, 'owner_users_list_should_be_200', ownerList);
  assert(Array.isArray(ownerList.body?.users), 'owner_users_list_should_return_array', ownerList);
  assert(ownerList.body.users.some((user) => user.id === 'e0f726d7-a32f-48e4-9b2c-06ac899660dc' && user.role === 'owner'), 'owner_user_should_be_listed_with_owner_role', ownerList.body);
  report.owner_lists = { status: ownerList.status, users_count: ownerList.body.users.length };

  const timestamp = Date.now();
  const tempAdminEmail = `tmp-admin-${timestamp}@example.com`;
  const tempSellerEmail = `tmp-seller-${timestamp}@example.com`;
  const tempPassword = 'TempPass123!';

  const createAdmin = await fetchJson('/api/admin/users', {
    method: 'POST',
    token: ownerToken,
    body: {
      email: tempAdminEmail,
      password: tempPassword,
      full_name: 'Temp Admin',
      role: 'admin'
    }
  });
  assert(createAdmin.status === 201, 'create_temp_admin_should_be_201', createAdmin);
  tempAdminId = createAdmin.body?.user_id ?? createAdmin.body?.user?.id ?? null;
  assert(Boolean(tempAdminId), 'missing_temp_admin_id', createAdmin);

  const createSeller = await fetchJson('/api/admin/users', {
    method: 'POST',
    token: ownerToken,
    body: {
      email: tempSellerEmail,
      password: tempPassword,
      full_name: 'Temp Seller',
      role: 'seller'
    }
  });
  assert(createSeller.status === 201, 'create_temp_seller_should_be_201', createSeller);
  tempSellerId = createSeller.body?.user_id ?? createSeller.body?.user?.id ?? null;
  assert(Boolean(tempSellerId), 'missing_temp_seller_id', createSeller);

  const adminAuth = await login(tempAdminEmail, tempPassword);
  const adminList = await fetchJson('/api/admin/users', { token: adminAuth.token });
  assert(adminList.status === 200, 'admin_users_list_should_be_200', adminList);
  assert(Array.isArray(adminList.body?.users), 'admin_users_list_should_return_array', adminList);
  report.admin_lists = { status: adminList.status, users_count: adminList.body.users.length };

  const sellerAuth = await login('bruno@gmail.com', '123456');
  const sellerList = await fetchJson('/api/admin/users', { token: sellerAuth.token });
  assert(sellerList.status === 403, 'seller_users_list_should_be_403', sellerList);
  report.seller_blocked = { status: sellerList.status, code: sellerList.body?.error?.code ?? null };

  const ownerProtected = await fetchJson('/api/admin/users/e0f726d7-a32f-48e4-9b2c-06ac899660dc', {
    method: 'PATCH',
    token: ownerToken,
    body: { role: 'seller' }
  });
  assert(ownerProtected.status === 409, 'owner_role_change_should_be_409', ownerProtected);
  assert(ownerProtected.body?.error?.code === 'protected_role', 'owner_role_change_code_should_be_protected_role', ownerProtected);
  report.owner_protected = { status: ownerProtected.status, code: ownerProtected.body?.error?.code ?? null };

  const validRoleChange = await fetchJson(`/api/admin/users/${tempSellerId}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { role: 'admin' }
  });
  assert(validRoleChange.status === 200, 'valid_role_change_should_be_200', validRoleChange);

  const verifyList = await fetchJson('/api/admin/users', { token: ownerToken });
  assert(verifyList.status === 200, 'verify_users_list_should_be_200', verifyList);
  const updatedSeller = (verifyList.body?.users ?? []).find((user) => user.id === tempSellerId);
  assert(updatedSeller?.role === 'admin', 'temp_seller_should_be_promoted_to_admin', { updatedSeller, verifyList: verifyList.body });
  report.role_change_valid = { status: validRoleChange.status, new_role: updatedSeller?.role ?? null };

  const selfDemotion = await fetchJson(`/api/admin/users/${tempAdminId}`, {
    method: 'PATCH',
    token: adminAuth.token,
    body: { role: 'seller' }
  });
  assert(selfDemotion.status === 403, 'self_demotion_should_be_403', selfDemotion);
  assert(selfDemotion.body?.error?.code === 'forbidden_role_change', 'self_demotion_code_should_be_forbidden_role_change', selfDemotion);
  report.self_demotion_blocked = { status: selfDemotion.status, code: selfDemotion.body?.error?.code ?? null };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, report }, null, 2));
} finally {
  if (tempAdminId) {
    await supabase.auth.admin.deleteUser(tempAdminId);
  }
  if (tempSellerId) {
    await supabase.auth.admin.deleteUser(tempSellerId);
  }
}
