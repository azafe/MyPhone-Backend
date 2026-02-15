import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authMiddleware } from './middleware/auth.js';
import { salesRouter } from './modules/sales/index.js';
import { tradeInsRouter } from './modules/tradeins/index.js';
import { installmentRulesRouter } from './modules/rules/index.js';
import { financeRouter } from './modules/finance/index.js';
import { adminUsersRouter } from './modules/adminUsers/index.js';
import { stockItemsRouter } from './modules/stockItems/index.js';
import { planCanjeValuesRouter } from './modules/planCanjeValues/index.js';

export const app = express();

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

const allowedOrigins = new Set<string>([
  'https://myphonetuc.netlify.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.has(origin)) {
    return true;
  }

  return /^https:\/\/[a-z0-9-]+\.netlify\.app$/i.test(origin);
}

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin || isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed'));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 204
};

const rateLimitWindowMin = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MIN, 15);
const rateLimitWindowMs = rateLimitWindowMin * 60 * 1000;
const globalRateLimitMax = parsePositiveInt(process.env.RATE_LIMIT_MAX, 300);
const adminRateLimitMax = parsePositiveInt(process.env.RATE_LIMIT_ADMIN_MAX, 60);

const globalRateLimit = rateLimit({
  windowMs: rateLimitWindowMs,
  max: globalRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many requests, please try again later.'
    }
  }
});

const adminUsersRateLimit = rateLimit({
  windowMs: rateLimitWindowMs,
  max: adminRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many admin requests, please try again later.'
    }
  }
});

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const appVersion = (() => {
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

const runtimeEnv = process.env.NODE_ENV === 'production' ? 'production' : 'development';

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(globalRateLimit);

app.get('/health', (_req, res) => res.json({
  ok: true,
  version: appVersion,
  timestamp: new Date().toISOString(),
  env: runtimeEnv
}));

app.use('/api', authMiddleware);

app.use('/api/sales', salesRouter);
app.use('/api/trade-ins', tradeInsRouter);
app.use('/api/installment-rules', installmentRulesRouter);
app.use('/api/finance', financeRouter);
app.use('/api/admin/users', adminUsersRateLimit, adminUsersRouter);
app.use('/api/stock-items', stockItemsRouter);
app.use('/api/plan-canje-values', planCanjeValuesRouter);

app.use((req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `Route not found: ${req.method} ${req.path}` } });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof Error && err.message === 'Origin not allowed') {
    return res.status(403).json({ error: { code: 'cors_forbidden', message: 'Origin not allowed' } });
  }
  res.status(500).json({ error: { code: 'internal_error', message: 'Unexpected error', details: String(err) } });
});
