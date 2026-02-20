import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const apply = process.argv.includes('--apply');
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRole) {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: 'missing_supabase_env' }, null, 2));
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRole, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function ts(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeConsistency({ sales, saleItems, stockItems }) {
  const salesMap = new Map((sales ?? []).map((sale) => [sale.id, sale]));
  const completedItems = (saleItems ?? []).filter((item) => salesMap.get(item.sale_id)?.status === 'completed');

  const completedSalesCount = (sales ?? []).filter((sale) => sale.status === 'completed').length;
  const completedItemsQty = completedItems.reduce((acc, item) => acc + Number(item.qty ?? 0), 0);

  const soldStockRows = (stockItems ?? []).filter((stock) => stock.status === 'sold');
  const soldStockCount = soldStockRows.length;

  const stockById = new Map((stockItems ?? []).map((stock) => [stock.id, stock]));
  const mismatches = [];
  for (const item of completedItems) {
    const stock = stockById.get(item.stock_item_id);
    if (!stock) {
      mismatches.push({ type: 'missing_stock_item', stock_item_id: item.stock_item_id, sale_id: item.sale_id });
      continue;
    }
    if (stock.status !== 'sold') {
      mismatches.push({
        type: 'completed_item_not_sold',
        stock_item_id: item.stock_item_id,
        sale_id: item.sale_id,
        stock_status: stock.status,
        stock_sale_id: stock.sale_id ?? null
      });
    }
  }

  const soldWithoutSaleId = soldStockRows.filter((stock) => !stock.sale_id).map((stock) => ({
    id: stock.id,
    imei: stock.imei ?? null,
    model: stock.model ?? null
  }));

  return {
    completed_sales_count: completedSalesCount,
    completed_sale_items_qty: completedItemsQty,
    sold_stock_count: soldStockCount,
    completed_item_stock_mismatches: mismatches,
    sold_without_sale_id: soldWithoutSaleId
  };
}

async function loadData() {
  const [{ data: sales, error: salesError }, { data: saleItems, error: saleItemsError }, { data: stockItems, error: stockItemsError }] = await Promise.all([
    supabase
      .from('sales')
      .select('id, status, sale_date, created_at'),
    supabase
      .from('sale_items')
      .select('sale_id, stock_item_id, qty'),
    supabase
      .from('stock_items')
      .select('id, status, sale_id, sold_at, imei, model')
  ]);

  if (salesError || saleItemsError || stockItemsError) {
    throw new Error(JSON.stringify({
      salesError: salesError?.message ?? null,
      saleItemsError: saleItemsError?.message ?? null,
      stockItemsError: stockItemsError?.message ?? null
    }));
  }

  return {
    sales: sales ?? [],
    saleItems: saleItems ?? [],
    stockItems: stockItems ?? []
  };
}

function planReconciliation({ sales, saleItems, stockItems }) {
  const salesMap = new Map((sales ?? []).map((sale) => [sale.id, sale]));
  const stockMap = new Map((stockItems ?? []).map((stock) => [stock.id, stock]));

  const itemLinksByStock = new Map();
  for (const item of saleItems ?? []) {
    const sale = salesMap.get(item.sale_id);
    if (!sale) continue;

    const links = itemLinksByStock.get(item.stock_item_id) ?? [];
    links.push({
      sale_id: item.sale_id,
      sale_status: sale.status,
      sale_date: sale.sale_date,
      sale_created_at: sale.created_at
    });
    itemLinksByStock.set(item.stock_item_id, links);
  }

  const changes = [];
  const warnings = [];

  for (const [stockId, links] of itemLinksByStock.entries()) {
    const current = stockMap.get(stockId);
    if (!current) {
      warnings.push({ type: 'stock_missing_for_sale_item', stock_item_id: stockId });
      continue;
    }

    const completed = links
      .filter((link) => link.sale_status === 'completed')
      .sort((a, b) => {
        const aTs = ts(a.sale_date) || ts(a.sale_created_at);
        const bTs = ts(b.sale_date) || ts(b.sale_created_at);
        return bTs - aTs;
      });

    if (completed.length > 0) {
      const winner = completed[0];
      const targetStatus = 'sold';
      const targetSaleId = winner.sale_id;

      if (current.status !== targetStatus || current.sale_id !== targetSaleId) {
        changes.push({
          stock_item_id: stockId,
          from_status: current.status,
          from_sale_id: current.sale_id ?? null,
          to_status: targetStatus,
          to_sale_id: targetSaleId,
          reason: 'linked_to_completed_sale_item'
        });
      }
      continue;
    }

    const hasOnlyCancelled = links.length > 0 && links.every((link) => link.sale_status === 'cancelled');
    if (hasOnlyCancelled) {
      if (current.status === 'sold' || current.sale_id) {
        changes.push({
          stock_item_id: stockId,
          from_status: current.status,
          from_sale_id: current.sale_id ?? null,
          to_status: 'available',
          to_sale_id: null,
          reason: 'only_linked_to_cancelled_sales'
        });
      }
    }
  }

  const soldWithoutSaleAndNoLinks = (stockItems ?? [])
    .filter((stock) => stock.status === 'sold' && !stock.sale_id && !itemLinksByStock.has(stock.id))
    .map((stock) => ({ id: stock.id, imei: stock.imei ?? null, model: stock.model ?? null }));

  if (soldWithoutSaleAndNoLinks.length > 0) {
    warnings.push({
      type: 'sold_stock_without_sale_reference_or_sale_item',
      count: soldWithoutSaleAndNoLinks.length,
      samples: soldWithoutSaleAndNoLinks.slice(0, 20)
    });
  }

  return { changes, warnings };
}

async function applyChanges(changes) {
  const results = [];

  for (const change of changes) {
    const payload = {
      status: change.to_status,
      sale_id: change.to_sale_id
    };

    if (change.to_status === 'available') {
      payload.sold_at = null;
    } else if (change.to_status === 'sold') {
      payload.sold_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('stock_items')
      .update(payload)
      .eq('id', change.stock_item_id);

    results.push({
      stock_item_id: change.stock_item_id,
      ok: !error,
      error: error?.message ?? null
    });
  }

  return results;
}

try {
  const before = await loadData();
  const beforeSummary = summarizeConsistency(before);
  const { changes, warnings } = planReconciliation(before);

  let applyResult = null;
  if (apply && changes.length > 0) {
    applyResult = await applyChanges(changes);
  }

  const after = apply ? await loadData() : before;
  const afterSummary = summarizeConsistency(after);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    mode: apply ? 'apply' : 'dry-run',
    planned_changes: changes.length,
    changes,
    warnings,
    apply_result: applyResult,
    before: beforeSummary,
    after: afterSummary
  }, null, 2));
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
