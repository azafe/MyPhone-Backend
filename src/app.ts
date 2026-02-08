import express from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/auth.js';
import { salesRouter } from './modules/sales/index.js';
import { tradeInsRouter } from './modules/tradeins/index.js';
import { installmentRulesRouter } from './modules/rules/index.js';
import { financeRouter } from './modules/finance/index.js';
import { adminUsersRouter } from './modules/adminUsers/index.js';
import { stockItemsRouter } from './modules/stockItems/index.js';

export const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api', authMiddleware);

app.use('/api/sales', salesRouter);
app.use('/api/trade-ins', tradeInsRouter);
app.use('/api/installment-rules', installmentRulesRouter);
app.use('/api/finance', financeRouter);
app.use('/api/admin/users', adminUsersRouter);
app.use('/api/stock-items', stockItemsRouter);

app.use((req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `Route not found: ${req.method} ${req.path}` } });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: { code: 'internal_error', message: 'Unexpected error', details: String(err) } });
});
