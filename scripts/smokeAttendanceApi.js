/**
 * Live API smoke: attendance list + OnBreak filter.
 * Usage: node scripts/smokeAttendanceApi.js
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
  const emp = await mongoose.connection.db.collection('employees').findOne({ email: 'admin@krira.ai' });
  if (!emp) throw new Error('admin@krira.ai not found');
  const token = jwt.sign({ id: String(emp._id), role: emp.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const headers = { Authorization: `Bearer ${token}` };

  const list = await fetch(`${base}/attendance?month=8&year=2026&limit=5`, { headers }).then((r) => r.json());
  if (!Array.isArray(list.data)) throw new Error(`list failed: ${JSON.stringify(list)}`);

  const sample = list.data[0];
  console.log('list', {
    total: list.total,
    sample: sample && {
      name: sample.employee_id?.name,
      check_in: sample.check_in,
      status: sample.status,
      break_total: sample.break_total,
    },
  });

  // Ensure seconds present on recent synced rows
  const todayRows = await fetch(`${base}/attendance?month=8&year=2026&limit=50`, { headers }).then((r) => r.json());
  const today = (todayRows.data || []).filter((d) => d.date === '2026-08-12');
  const withSeconds = today.filter((d) => d.check_in && String(d.check_in).split(':').length === 3);
  console.log('today check_in with seconds', `${withSeconds.length}/${today.length}`);

  const todayDoc = await mongoose.connection.db.collection('attendances').findOne({
    date: '2026-08-12',
    status: 'Working',
    check_out: null,
  });
  if (!todayDoc) throw new Error('No Working row for today to test OnBreak filter');

  const before = {
    break_started_at: todayDoc.break_started_at ?? null,
    status: todayDoc.status,
  };

  await mongoose.connection.db.collection('attendances').updateOne(
    { _id: todayDoc._id },
    { $set: { break_started_at: '10:05:00', status: 'OnBreak' } }
  );

  const onBreak = await fetch(`${base}/attendance?month=8&year=2026&status=OnBreak&limit=20`, { headers }).then((r) =>
    r.json()
  );
  const found = (onBreak.data || []).find((d) => String(d._id) === String(todayDoc._id));
  console.log('onBreak filter', {
    total: onBreak.total,
    found: !!found,
    status: found?.status,
    break_started_at: found?.break_started_at,
  });

  // restore
  await mongoose.connection.db.collection('attendances').updateOne(
    { _id: todayDoc._id },
    { $set: { break_started_at: before.break_started_at, status: before.status } }
  );

  if (!found || found.status !== 'OnBreak') {
    throw new Error('OnBreak filter/list normalization failed');
  }
  if (withSeconds.length !== today.length) {
    throw new Error(`Expected all today check_ins to include seconds, got ${withSeconds.length}/${today.length}`);
  }

  console.log(JSON.stringify({ ok: true }, null, 2));
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
