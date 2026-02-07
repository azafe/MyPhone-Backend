# MyPhone Backend V1

Backend V1 para MyPhone.

## Requisitos
- Node.js 18+
- Supabase project con tablas: `profiles`, `sales`, `sale_items`, `stock_items`, `trade_ins`, `installment_rules`
- RPC SQL: `rpc_create_sale(payload jsonb)`

## Env Vars
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PORT`

## Scripts
- `npm run dev`
- `npm run build`
- `npm start`

## Formato de errores
```json
{ "error": { "code": "...", "message": "...", "details": "..." } }
```

## Auth
Se requiere `Authorization: Bearer <token>` en todos los endpoints `/api/*`.

## Endpoints y ejemplos curl

### Health
```bash
curl -s http://localhost:3000/health
```

### Sales
```bash
curl -s -X POST http://localhost:3000/api/sales \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sale_date": "2026-02-05T15:30:00.000Z",
    "customer": { "name": "Juan Perez", "phone": "+549111234567" },
    "payment": { "method": "card", "card_brand": "visa", "installments": 6, "surcharge_pct": 15, "deposit_ars": 0, "total_ars": 900000 },
    "items": [{ "stock_item_id": "stock-uuid", "sale_price_ars": 900000 }],
    "trade_in": {
      "enabled": true,
      "device": { "brand": "Apple", "model": "iPhone 11", "storage_gb": 64, "color": "black", "condition": "good", "imei": "123456789" },
      "trade_value_usd": 150,
      "fx_rate_used": 1200
    }
  }'
```

### Trade-ins
```bash
curl -s -X POST http://localhost:3000/api/trade-ins \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "device": { "brand": "Samsung", "model": "S21", "storage_gb": 128, "color": "gray", "condition": "ok", "imei": "987654321" },
    "trade_value_usd": 120,
    "fx_rate_used": 1200,
    "status": "pending",
    "notes": "Pantalla con detalle"
  }'
```

```bash
curl -s -X PATCH http://localhost:3000/api/trade-ins/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "trade_value_usd": 130,
    "status": "valued",
    "notes": "Revisado"
  }'
```

```bash
curl -s -X POST http://localhost:3000/api/trade-ins/<id>/convert-to-stock \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "category": "used_premium",
    "sale_price_ars": 650000,
    "warranty_days_default": 90,
    "imei": "987654321",
    "notes": "Listo para venta"
  }'
```

### Installment Rules (admin)
```bash
curl -s -X GET http://localhost:3000/api/installment-rules \
  -H "Authorization: Bearer $TOKEN"
```

```bash
curl -s -X POST http://localhost:3000/api/installment-rules \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "card_brand": "visa",
    "installments": 6,
    "surcharge_pct": 15,
    "is_active": true
  }'
```

```bash
curl -s -X PATCH http://localhost:3000/api/installment-rules/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "surcharge_pct": 12,
    "is_active": true
  }'
```

```bash
curl -s -X DELETE http://localhost:3000/api/installment-rules/<id> \
  -H "Authorization: Bearer $TOKEN"
```

### Finance Summary
```bash
curl -s "http://localhost:3000/api/finance/summary?from=2026-02-01&to=2026-02-05" \
  -H "Authorization: Bearer $TOKEN"
```

### Admin Users (admin)
```bash
curl -s -X POST http://localhost:3000/api/admin/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "seller@myphone.com",
    "password": "supersecret",
    "full_name": "Seller One",
    "role": "seller"
  }'
```

```bash
curl -s -X PATCH http://localhost:3000/api/admin/users/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Seller Updated",
    "role": "admin"
  }'
```

## Notas
- `rpc_create_sale(payload jsonb)` debe devolver `sale_id`, `trade_in_id` y `customer_id` (o una estructura equivalente).
- `profiles` debe tener `id` = `auth.users.id`, `role` y `full_name`.
# MyPhone-Backend
