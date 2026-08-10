/**
 * Fetch check-in / check-out / break data for July & August from DB `hrms`.
 * Schema uses: userId, checkIn, checkOut, breaks[], totalWorkedSeconds
 * Usage: node scripts/queryJulAugAttendance.js
 */
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'exports');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function secondsToHms(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${pad2(m)}m`;
  return `${m}m ${pad2(r)}s`;
}

function secondsToHm(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Normalize Date or string to HH:MM:SS / HH:MM */
function toTime(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    return `${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`;
  }
  if (typeof v === 'string') {
    // ISO datetime -> local-ish time portion, or already HH:MM
    if (v.includes('T')) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      }
      return v.split('T')[1]?.slice(0, 8) || v;
    }
    return v;
  }
  return String(v);
}

function breakSeconds(breaks) {
  if (!Array.isArray(breaks) || !breaks.length) return 0;
  let total = 0;
  for (const b of breaks) {
    if (typeof b?.durationSeconds === 'number') {
      total += b.durationSeconds;
      continue;
    }
    if (typeof b?.duration === 'number') {
      total += b.duration;
      continue;
    }
    if (b?.start && b?.end) {
      const start = new Date(b.start).getTime();
      const end = new Date(b.end).getTime();
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        total += Math.round((end - start) / 1000);
      }
    }
  }
  return total;
}

function formatBreaksDetail(breaks) {
  if (!Array.isArray(breaks) || !breaks.length) return '';
  return breaks
    .map((b, i) => {
      const start = toTime(b.start || b.breakStart || b.from);
      const end = toTime(b.end || b.breakEnd || b.to);
      const dur =
        b.durationSeconds != null
          ? secondsToHm(b.durationSeconds)
          : b.duration != null
            ? secondsToHm(b.duration)
            : '';
      return `#${i + 1} ${start || '?'}-${end || 'open'}${dur ? ` (${dur})` : ''}`;
    })
    .join(' | ');
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  await mongoose.connect(uri, { dbName: 'hrms' });
  const db = mongoose.connection.db;

  const att = db.collection('attendances');
  const users = db.collection('users');

  const sample = await att.findOne({ date: { $regex: '^2026-07' } });
  console.log('Sample attendance (Jul):\n', JSON.stringify(sample, null, 2)?.slice(0, 2500));

  const months = ['2026-07', '2026-08'];
  const rows = await att
    .find({ date: { $regex: `^(${months.join('|')})` } })
    .sort({ date: 1, userId: 1 })
    .toArray();

  console.log(`\nMatched rows: ${rows.length}`);

  const userIds = [
    ...new Set(rows.map((r) => String(r.userId)).filter((id) => id && id !== 'undefined')),
  ];
  const objectIds = userIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const userDocs = await users
    .find({ _id: { $in: objectIds } })
    .project({
      name: 1,
      fullName: 1,
      firstName: 1,
      lastName: 1,
      email: 1,
      employeeId: 1,
      employee_id: 1,
      empId: 1,
      role: 1,
      department: 1,
    })
    .toArray();

  const userMap = new Map(userDocs.map((u) => [String(u._id), u]));
  console.log(`Users resolved: ${userDocs.length}/${userIds.length}`);
  if (userDocs[0]) {
    console.log('User sample keys:', Object.keys(userDocs[0]).join(', '));
  }

  function displayName(u) {
    if (!u) return '';
    if (u.name) return u.name;
    if (u.fullName) return u.fullName;
    const parts = [u.firstName, u.lastName].filter(Boolean);
    return parts.join(' ') || u.email || '';
  }

  function empCode(u) {
    if (!u) return '';
    return u.employeeId || u.employee_id || u.empId || '';
  }

  const outRows = rows.map((r) => {
    const uid = String(r.userId);
    const u = userMap.get(uid) || {};
    const brSec = breakSeconds(r.breaks);
    const workedSec = Number(r.totalWorkedSeconds) || 0;
    return {
      user_id: uid,
      employee_code: empCode(u),
      employee_name: displayName(u),
      email: u.email || '',
      department: u.department || '',
      role: u.role || '',
      date: typeof r.date === 'string' ? r.date : String(r.date),
      month: String(r.date).slice(0, 7),
      check_in: toTime(r.checkIn),
      check_out: toTime(r.checkOut),
      break_count: Array.isArray(r.breaks) ? r.breaks.length : 0,
      break_total_seconds: brSec,
      break_total: secondsToHm(brSec),
      breaks_detail: formatBreaksDetail(r.breaks),
      worked_hours: secondsToHms(workedSec),
      worked_seconds: workedSec,
      low_time: !!r.lowTimeFlag,
      extra_time: !!r.extraTimeFlag,
      is_manual: !!r.isManualFlag,
      location: r.location || '',
    };
  });

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(OUT_DIR, `hrms_attendance_jul_aug_${stamp}.json`);
  const csvPath = path.join(OUT_DIR, `hrms_attendance_jul_aug_${stamp}.csv`);
  const summaryPath = path.join(OUT_DIR, `hrms_attendance_jul_aug_summary_${stamp}.json`);

  fs.writeFileSync(jsonPath, JSON.stringify(outRows, null, 2));

  const headers = [
    'user_id',
    'employee_code',
    'employee_name',
    'email',
    'department',
    'role',
    'date',
    'month',
    'check_in',
    'check_out',
    'break_count',
    'break_total_seconds',
    'break_total',
    'breaks_detail',
    'worked_hours',
    'worked_seconds',
    'low_time',
    'extra_time',
    'is_manual',
    'location',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(
    csvPath,
    [headers.join(','), ...outRows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n')
  );

  // Summaries
  const byMonth = {};
  const byEmployee = {};
  for (const r of outRows) {
    byMonth[r.month] ??= {
      days: 0,
      with_checkout: 0,
      total_break_seconds: 0,
      total_worked_seconds: 0,
      unique_employees: new Set(),
    };
    byMonth[r.month].days += 1;
    if (r.check_out) byMonth[r.month].with_checkout += 1;
    byMonth[r.month].total_break_seconds += r.break_total_seconds;
    byMonth[r.month].total_worked_seconds += r.worked_seconds;
    byMonth[r.month].unique_employees.add(r.user_id);

    const key = r.user_id || r.employee_name || 'unknown';
    byEmployee[key] ??= {
      user_id: r.user_id,
      employee_code: r.employee_code,
      employee_name: r.employee_name,
      email: r.email,
      department: r.department,
      days: 0,
      jul_days: 0,
      aug_days: 0,
      total_break_seconds: 0,
      total_worked_seconds: 0,
    };
    byEmployee[key].days += 1;
    if (r.month === '2026-07') byEmployee[key].jul_days += 1;
    if (r.month === '2026-08') byEmployee[key].aug_days += 1;
    byEmployee[key].total_break_seconds += r.break_total_seconds;
    byEmployee[key].total_worked_seconds += r.worked_seconds;
  }

  const monthSummary = Object.fromEntries(
    Object.entries(byMonth).map(([m, s]) => [
      m,
      {
        days: s.days,
        with_checkout: s.with_checkout,
        unique_employees: s.unique_employees.size,
        total_break: secondsToHm(s.total_break_seconds),
        total_worked: secondsToHms(s.total_worked_seconds),
      },
    ])
  );

  const empSummary = Object.values(byEmployee)
    .map((e) => ({
      ...e,
      total_break: secondsToHm(e.total_break_seconds),
      total_worked: secondsToHms(e.total_worked_seconds),
    }))
    .sort((a, b) => a.employee_name.localeCompare(b.employee_name));

  fs.writeFileSync(
    summaryPath,
    JSON.stringify({ months: monthSummary, employees: empSummary }, null, 2)
  );

  console.log('\n=== Month summary ===');
  for (const [m, s] of Object.entries(monthSummary)) {
    console.log(
      `  ${m}: ${s.days} records, ${s.unique_employees} employees, checkout ${s.with_checkout}, break ${s.total_break}, worked ${s.total_worked}`
    );
  }

  console.log('\n=== Sample rows (first 40) ===');
  console.log('name | date | in | out | break | worked');
  for (const r of outRows.slice(0, 40)) {
    console.log(
      `${r.employee_name || '-'} | ${r.date} | ${r.check_in || '-'} | ${r.check_out || '-'} | ${r.break_total} (${r.break_count}) | ${r.worked_hours}`
    );
  }

  console.log(`\nEmployees in period: ${empSummary.length}`);
  console.log('Wrote:');
  console.log(' ', jsonPath);
  console.log(' ', csvPath);
  console.log(' ', summaryPath);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
