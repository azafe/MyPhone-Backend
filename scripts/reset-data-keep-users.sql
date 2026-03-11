-- =============================================================================
-- RESET DE DATOS — LIMPIEZA PARA PRIMER USO REAL
-- =============================================================================
-- Elimina: celulares (stock), ventas, garantías, permutas, clientes, auditoría
-- Conserva: usuarios (profiles), passkeys, reglas de cuotas, plan canje
--
-- CÓMO USARLO:
--   1. Abrí el SQL Editor de Supabase
--   2. Pegá este script completo
--   3. Ejecutá y verificá los conteos al final
-- =============================================================================

BEGIN;

-- 1. sale_audit_logs (FK → sales)
DELETE FROM public.sale_audit_logs;

-- 2. sale_payments (FK → sales ON DELETE CASCADE, pero siendo explícitos)
DELETE FROM public.sale_payments;

-- 3. warranties (FK → sales, stock_items, customers)
DELETE FROM public.warranties;

-- 4. sale_items (FK → sales CASCADE, FK → stock_items RESTRICT)
--    Debe ir antes que stock_items y antes que sales
DELETE FROM public.sale_items;

-- 5. trade_ins (puede tener FK → sales; lo borramos antes que sales para evitar conflictos)
DELETE FROM public.trade_ins;

-- 6. sales (ahora sin dependientes)
DELETE FROM public.sales;

-- 7. stock_items (ahora sin sale_items que los referencian)
DELETE FROM public.stock_items;

-- 8. customers (ahora sin warranties que los referencian)
DELETE FROM public.customers;

-- 9. idempotency_keys (FK → profiles ON DELETE CASCADE, limpiamos por las dudas)
DELETE FROM public.idempotency_keys;

-- 10. audit_logs (log general del sistema)
DELETE FROM public.audit_logs;

COMMIT;

-- =============================================================================
-- VERIFICACIÓN — ejecutar después del COMMIT
-- Todos estos valores deben ser 0 si el reset fue exitoso.
-- Los últimos 3 deben ser > 0 (son los datos que conservamos).
-- =============================================================================
SELECT
  (SELECT COUNT(*) FROM public.stock_items)       AS stock_items,
  (SELECT COUNT(*) FROM public.sales)             AS sales,
  (SELECT COUNT(*) FROM public.sale_items)        AS sale_items,
  (SELECT COUNT(*) FROM public.sale_payments)     AS sale_payments,
  (SELECT COUNT(*) FROM public.warranties)        AS warranties,
  (SELECT COUNT(*) FROM public.trade_ins)         AS trade_ins,
  (SELECT COUNT(*) FROM public.customers)         AS customers,
  (SELECT COUNT(*) FROM public.audit_logs)        AS audit_logs,
  (SELECT COUNT(*) FROM public.sale_audit_logs)   AS sale_audit_logs,
  (SELECT COUNT(*) FROM public.idempotency_keys)  AS idempotency_keys,
  -- Estos deben quedar con datos:
  (SELECT COUNT(*) FROM public.profiles)          AS usuarios_conservados,
  (SELECT COUNT(*) FROM public.auth_passkeys)     AS passkeys_conservadas,
  (SELECT COUNT(*) FROM public.installment_rules) AS reglas_cuotas_conservadas;
