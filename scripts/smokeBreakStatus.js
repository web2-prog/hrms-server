/**
 * End-to-end attendance break status smoke test against NewHRMS.
 * Uses a temporary attendance row on a mapped employee for today, then restores.
 *
 * Usage: node scripts/smokeBreakStatus.js
 */
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

import { connectDB } from '../config/db.js';
import Attendance from '../models/Attendance.js';
import { recalculateAttendanceFields } from '../services/attendanceCalc.js';
import { minutesBetween } from '../utils/helpers.js';

dotenv.config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.join(__dirname, '..', 'exports', 'hrms_to_newhrms_map.json');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  const empId = map.find((m) => m.status === 'active')?.new_mongo_id;
  assert(empId, 'No active mapped employee');

  await connectDB();

  const date = '2099-01-01'; // isolated test date — never real production day
  await Attendance.deleteMany({ employee_id: empId, date });

  const rec = await Attendance.create({
    employee_id: empId,
    date,
    check_in: '09:00:00',
    check_out: null,
    break_total: 0,
    break_started_at: null,
    status: 'Working',
    working_hours: 0,
    surplus_shortfall: 0,
  });

  // start break
  rec.break_started_at = '10:15:30';
  rec.status = 'OnBreak';
  await rec.save();

  let loaded = await Attendance.findById(rec._id).lean();
  assert(loaded.status === 'OnBreak', `Expected OnBreak, got ${loaded.status}`);
  assert(loaded.break_started_at === '10:15:30', 'break_started_at not saved');

  // list normalization path
  const fieldsWhileBreak = recalculateAttendanceFields(loaded, 8.25);
  assert(fieldsWhileBreak.status === 'OnBreak', `calc OnBreak failed: ${fieldsWhileBreak.status}`);

  // end break
  const mins = minutesBetween(loaded.break_started_at, '10:25:30');
  loaded = await Attendance.findById(rec._id);
  loaded.break_total = Number(((loaded.break_total || 0) + Math.max(0, mins)).toFixed(4));
  loaded.break_started_at = null;
  loaded.status = 'Working';
  await loaded.save();

  const after = await Attendance.findById(rec._id).lean();
  assert(after.status === 'Working', `Expected Working after end break, got ${after.status}`);
  assert(!after.break_started_at, 'break_started_at should be null');
  assert(Math.abs(after.break_total - 10) < 0.001, `Expected 10m break, got ${after.break_total}`);

  const fieldsWorking = recalculateAttendanceFields(after, 8.25);
  assert(fieldsWorking.status === 'Working', `calc Working failed: ${fieldsWorking.status}`);

  // checkout with prior break
  const done = await Attendance.findById(rec._id);
  done.check_out = '18:00:00';
  Object.assign(done, recalculateAttendanceFields(done, 8.25));
  await done.save();
  const final = await Attendance.findById(rec._id).lean();
  assert(['Extra', 'Low', 'OnTime'].includes(final.status), `Unexpected final status ${final.status}`);
  assert(final.working_hours > 0, 'working_hours should be > 0 after checkout');

  await Attendance.deleteMany({ employee_id: empId, date });
  console.log(JSON.stringify({
    ok: true,
    employee_id: empId,
    break_flow: 'OnBreak → Working → checked out',
    final_status: final.status,
    final_hours: final.working_hours,
    break_total: after.break_total,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
