import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { ensureDB } from './config/db.js';

import authRoutes from './routes/auth.js';
import deptRoutes from './routes/departments.js';
import empRoutes from './routes/employees.js';
import attRoutes from './routes/attendance.js';
import leaveRoutes from './routes/leaves.js';
import holidayRoutes from './routes/holidays.js';
import salaryRoutes from './routes/salary.js';
import performanceRoutes from './routes/performance.js';
import overtimeRoutes from './routes/overtime.js';
import miscRoutes from './routes/misc.js';
import analyticsRoutes from './routes/analytics.js';
import policyRoutes from './routes/policies.js';
import helpdeskRoutes from './routes/helpdesk.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/**
 * CORS origins are driven by the CORS_ORIGINS env var (comma-separated list,
 * e.g. CORS_ORIGINS=http://localhost:3003,https://client.example.com).
 * If unset, falls back to allowing any origin.
 *
 * NOTE: in the cors package an array ['*'] does strict equality matching and
 * blocks every real origin — '*' must be a plain string, which is why the
 * fallback returns the string, not an array.
 */
function parseCorsOrigins(raw) {
  if (!raw) return '*';
  const origins = raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '')) // Origin headers never carry a trailing slash
    .filter(Boolean);
  return origins.length ? origins : '*';
}

app.use(cors({ origin: parseCorsOrigins(process.env.CORS_ORIGINS) }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/health', (_req, res) => res.json({ ok: true, db: process.env.MONGODB_DB_NAME }));

app.use('/api/auth', authRoutes);
app.use('/api/departments', deptRoutes);
app.use('/api/employees', empRoutes);
app.use('/api/attendance', attRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/holidays', holidayRoutes);
app.use('/api/salary', salaryRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/overtime', overtimeRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/policies', policyRoutes);
app.use('/api/helpdesk', helpdeskRoutes);
app.use('/api', miscRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5001;
const isVercel = !!process.env.VERCEL;

if (!isVercel) {
  // Local dev: connect once, then listen.
  ensureDB()
    .then(() => app.listen(PORT, () => console.log(`HRMS-Spec API on :${PORT}`)))
    .catch((e) => {
      console.error('DB connection failed', e);
      process.exit(1);
    });
}

/**
 * Vercel serverless entry (@vercel/node).
 *
 * The DB connection is AWAITED before Express handles the request. Without
 * this, Mongoose buffers every model operation for 10s while the connection
 * is still establishing on a cold start — and if the connection never comes
 * up (missing MONGODB_URI, Atlas network allowlist, DNS), every request dies
 * with "Operation employees.findOne() buffering timed out after 10000ms".
 * Here an unreachable DB fails fast with a clear 503 instead.
 */
export default async function handler(req, res) {
  try {
    await ensureDB();
  } catch (e) {
    console.error('DB connection failed', e);
    res.status(503).json({ message: 'Database unavailable. Please try again.' });
    return;
  }
  return app(req, res);
}
