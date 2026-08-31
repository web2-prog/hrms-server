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
import uploadRoutes from './routes/uploads.js';
import { corsOptions, assertJwtSecret } from './middleware/security.js';
import { startAutoCheckoutScheduler, closeStaleOpenSessions } from './services/autoCheckout.js';

dotenv.config();
assertJwtSecret();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors(corsOptions()));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use('/uploads', uploadRoutes);

app.get('/health', (_req, res) => res.json({ ok: true, db: process.env.MONGODB_DB_NAME }));

app.get('/api/jobs/auto-checkout', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || '');
  const headerSecret = String(req.headers['x-cron-secret'] || '');
  const isVercelCron = /vercel-cron/i.test(String(req.headers['user-agent'] || ''));
  const ok = secret
    ? auth === `Bearer ${secret}` || headerSecret === secret
    : isVercelCron || (!process.env.VERCEL && process.env.NODE_ENV !== 'production');
  if (!ok) return res.status(401).json({ message: 'Unauthorized' });
  try {
    await ensureDB();
    const result = await closeStaleOpenSessions();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

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
    .then(() => {
      startAutoCheckoutScheduler();
      app.listen(PORT, () => console.log(`HRMS-Spec API on :${PORT}`));
    })
    .catch((e) => {
      console.error('DB connection failed', e);
      process.exit(1);
    });
}

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
