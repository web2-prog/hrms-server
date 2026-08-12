/**
 * Smoke test Admin/HR Today board API.
 * Usage: node scripts/smokeTodayApi.js
 */
import dns from 'dns';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

dotenv.config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const base = process.env.API_BASE || 'http://localhost:5001/api';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'NewHRMS' });
  const admin = await mongoose.connection.db.collection('employees').findOne({ email: 'admin@krira.ai' });
  if (!admin) throw new Error('admin missing');
  const token = jwt.sign({ id: String(admin._id), role: admin.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const list = await fetch(`${base}/attendance/today?limit=100`, { headers }).then((r) => r.json());
  if (!Array.isArray(list.data)) throw new Error(`today list failed: ${JSON.stringify(list)}`);
  console.log('today list', { total: list.total, date: list.date, counts: list.counts, sample: list.data[0] });

  const target = list.data.find((r) => r.live_status === 'Working' || r.live_status === 'Absent') || list.data[0];
  if (!target) throw new Error('no employees');

  const empId = target.employee._id;
  const before = {
    check_in: target.check_in,
    check_out: target.check_out,
    break_total: target.break_total,
    break_started_at: target.break_started_at,
    penalty_waived: target.penalty_waived,
  };

  const updated = await fetch(`${base}/attendance/today/${empId}`, {
    headers,
    method: 'PUT',
    body: JSON.stringify({
      check_in: before.check_in || '09:30:00',
      check_out: null,
      break_total: Number(before.break_total || 0),
      break_started_at: '10:40:00',
      penalty_waived: true,
    }),
  }).then((r) => r.json());

  if (updated.live_status !== 'OnBreak') {
    throw new Error(`Expected OnBreak after setting break_started_at, got ${updated.live_status}`);
  }
  if (!updated.penalty_waived) throw new Error('penalty_waived not saved');

  const filtered = await fetch(`${base}/attendance/today?live_status=OnBreak&limit=50`, { headers }).then((r) =>
    r.json()
  );
  const found = (filtered.data || []).find((r) => String(r.employee._id) === String(empId));
  if (!found) throw new Error('OnBreak filter did not return updated employee');

  // restore
  await fetch(`${base}/attendance/today/${empId}`, {
    headers,
    method: 'PUT',
    body: JSON.stringify({
      check_in: before.check_in,
      check_out: before.check_out,
      break_total: before.break_total,
      break_started_at: before.break_started_at,
      end_break: false,
      penalty_waived: before.penalty_waived,
    }),
  });

  console.log(JSON.stringify({ ok: true, restored: empId }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
