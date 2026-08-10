import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { connectDB } from './config/db.js';

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

app.use(cors());
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

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`HRMS-Spec API on :${PORT}`));
  })
  .catch((e) => {
    console.error('DB connection failed', e);
    process.exit(1);
  });
