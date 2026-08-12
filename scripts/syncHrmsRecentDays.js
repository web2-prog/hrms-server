/**
 * Sync recent-day HR data from MongoDB `hrms` → `NewHRMS`, and write an MD report.
 *
 * Default range: 2026-08-09 → today (Asia/Kolkata calendar date).
 * Covers: attendance (check-in/out, breaks, worked hours), leaves, management OT.
 *
 * Usage:
 *   node scripts/syncHrmsRecentDays.js
 *   node scripts/syncHrmsRecentDays.js --dry-run
 *   node scripts/syncHrmsRecentDays.js --from 2026-08-09 --to 2026-08-12
 */
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';

import { connectDB } from '../config/db.js';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import OvertimeRequest from '../models/OvertimeRequest.js';
import { getEffectiveShiftForEmployee, computeDailyStatus } from '../services/shift.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';

dotenv.config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_DIR = path.join(__dirname, '..', 'exports');
const MAP_PATH = path.join(EXPORTS_DIR, 'hrms_to_newhrms_map.json');
const DRY_RUN = process.argv.includes('--dry-run');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function todayIstYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const FROM = argValue('--from', '2026-08-09');
const TO = argValue('--to', todayIstYmd());

function blank(v) {
  return String(v ?? '').trim();
}

function normalizeNameKey(name) {
  return blank(name).toLowerCase().replace(/\s+/g, ' ');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function secondsToHms(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${pad2(m)}m ${pad2(r)}s`;
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

/** Prefer HH:MM:SS for NewHRMS (second precision) */
function toHHMMSS(v) {
  if (v == null || v === '') return null;
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === 'string' && v.includes('T')) d = new Date(v);
  else if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return `${pad2(Number(m[1]))}:${m[2]}:${m[3] || '00'}`;
    d = new Date(v);
  } else return null;
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === 'hour')?.value;
  const mm = parts.find((p) => p.type === 'minute')?.value;
  const ss = parts.find((p) => p.type === 'second')?.value;
  if (hh == null || mm == null) return null;
  return `${hh}:${mm}:${ss || '00'}`;
}

function breakSeconds(breaks) {
  if (!Array.isArray(breaks) || !breaks.length) return 0;
  let sec = 0;
  for (const b of breaks) {
    if (typeof b?.durationSeconds === 'number') sec += b.durationSeconds;
    else if (b?.start && b?.end) {
      const a = new Date(b.start).getTime();
      const c = new Date(b.end).getTime();
      if (!Number.isNaN(a) && !Number.isNaN(c) && c >= a) sec += (c - a) / 1000;
    }
  }
  return Math.round(sec);
}

function breakMinutes(breaks) {
  return Math.round(breakSeconds(breaks) / 60);
}

function formatBreaksDetail(breaks) {
  if (!Array.isArray(breaks) || !breaks.length) return '—';
  return breaks
    .map((b, i) => {
      const start = toHHMMSS(b.start) || '?';
      const end = toHHMMSS(b.end) || 'open';
      const dur =
        b.durationSeconds != null
          ? secondsToHm(b.durationSeconds)
          : b.start && b.end
            ? secondsToHm((new Date(b.end) - new Date(b.start)) / 1000)
            : '';
      return `#${i + 1} ${start}–${end}${dur ? ` (${dur})` : ''}`;
    })
    .join('; ');
}

function mapLeaveStatus(s) {
  const v = blank(s).toLowerCase();
  if (v === 'approved') return 'Approved';
  if (v === 'rejected') return 'Rejected';
  return 'Pending';
}

function mapLeaveDayType(category) {
  const c = blank(category).toLowerCase();
  if (c.includes('half')) return 'Half Day';
  return 'Full Day';
}

function shouldImportLeave(category) {
  const c = blank(category).toLowerCase();
  return (
    c.includes('paid') ||
    c.includes('unpaid') ||
    c.includes('half') ||
    c.includes('extra time')
  );
}

function mapOtStatus(s) {
  const v = blank(s).toLowerCase();
  if (v === 'approved') return 'Approved';
  if (v === 'rejected') return 'Rejected';
  return 'Pending';
}

function datesOverlapRange(from, to, rangeFrom, rangeTo) {
  // inclusive YYYY-MM-DD string compare
  return from <= rangeTo && to >= rangeFrom;
}

function mdEscape(s) {
  return blank(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

async function main() {
  console.log(
    `Sync hrms → NewHRMS ${FROM}..${TO}${DRY_RUN ? ' (DRY RUN)' : ''}`
  );

  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
    throw new Error(`Invalid date range: ${FROM} .. ${TO}`);
  }
  if (FROM > TO) throw new Error(`FROM (${FROM}) > TO (${TO})`);

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI required');
  if (!fs.existsSync(MAP_PATH)) {
    throw new Error(`Employee map missing: ${MAP_PATH}. Run migrate:hrms first.`);
  }

  const mapRows = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  const legacyToMap = new Map(mapRows.map((r) => [r.legacy_user_id, r]));
  const nameToMap = new Map(
    mapRows.map((r) => [normalizeNameKey(r.name), r])
  );

  const hrmsConn = await mongoose.createConnection(uri, { dbName: 'hrms' }).asPromise();
  const hrms = hrmsConn.db;

  await connectDB();

  // Resolve NewHRMS employees
  const empIds = mapRows.map((r) => r.new_mongo_id).filter((id) => mongoose.isValidObjectId(id));
  const employees = await Employee.find({
    _id: { $in: empIds.map((id) => new mongoose.Types.ObjectId(id)) },
  }).lean();
  const empById = new Map(employees.map((e) => [String(e._id), e]));

  const legacyToEmp = new Map();
  for (const row of mapRows) {
    const emp = empById.get(row.new_mongo_id);
    if (emp) legacyToEmp.set(row.legacy_user_id, emp);
  }
  console.log(`Mapped employees available in NewHRMS: ${legacyToEmp.size}/${mapRows.length}`);

  // ---- Fetch source data ----
  const attRows = await hrms
    .collection('attendances')
    .find({ date: { $gte: FROM, $lte: TO } })
    .sort({ date: 1, userId: 1 })
    .toArray();
  console.log(`Attendance rows ${FROM}..${TO}: ${attRows.length}`);

  const leaveRows = await hrms.collection('leaverequests').find({}).toArray();
  const leaveInRange = leaveRows.filter((lv) => {
    const from = blank(lv.startDate).slice(0, 10);
    const to = blank(lv.endDate || lv.startDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return false;
    return datesOverlapRange(from, to || from, FROM, TO);
  });
  console.log(`Leave rows overlapping range: ${leaveInRange.length}`);

  // Extra / general OT flags on attendance + management OT
  const userIdsNeeded = [
    ...new Set([
      ...attRows.map((r) => String(r.userId)),
      ...leaveInRange.map((r) => String(r.userId)),
    ]),
  ];
  const userObjectIds = userIdsNeeded
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const users = await hrms
    .collection('users')
    .find({ _id: { $in: userObjectIds } })
    .project({ name: 1, email: 1, department: 1, role: 1 })
    .toArray();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  // ---- Build report rows + apply ----
  const thresholdCache = new Map();
  async function thresholdFor(empId) {
    const key = String(empId);
    if (thresholdCache.has(key)) return thresholdCache.get(key);
    if (DRY_RUN) {
      thresholdCache.set(key, 8.25);
      return 8.25;
    }
    const shift = await getEffectiveShiftForEmployee(empId);
    const t = shift?.working_hours_per_day ?? 8.25;
    thresholdCache.set(key, t);
    return t;
  }

  const reportByEmp = new Map(); // key → { meta, attendance[], leaves[], ot[] }
  function ensureEmpBucket(legacyId, emp, fallbackName) {
    const key = emp ? String(emp._id) : `unmapped:${legacyId}`;
    if (!reportByEmp.has(key)) {
      const mapRow = legacyToMap.get(String(legacyId));
      const u = userById.get(String(legacyId));
      reportByEmp.set(key, {
        mapped: !!emp,
        employee_code: emp?.employee_id || mapRow?.employee_id || '',
        name: emp?.name || mapRow?.name || u?.name || fallbackName || legacyId,
        email: emp?.email || mapRow?.email || u?.email || '',
        department: mapRow?.department || u?.department || '',
        legacy_user_id: String(legacyId),
        attendance: [],
        leaves: [],
        overtime: [],
      });
    }
    return reportByEmp.get(key);
  }

  let attUpserted = 0;
  let attSkipped = 0;
  const monthKeys = new Set();
  const touchedEmpIds = new Set();
  const ops = [];

  const bar = new cliProgress.SingleBar(
    {
      format: 'Attendance |{bar}| {percentage}% | {value}/{total}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(attRows.length, 0);

  async function flushAtt() {
    if (!ops.length || DRY_RUN) {
      ops.length = 0;
      return;
    }
    const batch = ops.splice(0, ops.length);
    try {
      await Attendance.bulkWrite(batch, { ordered: false });
      attUpserted += batch.length;
    } catch {
      for (const op of batch) {
        try {
          await Attendance.bulkWrite([op], { ordered: false });
          attUpserted += 1;
        } catch {
          // skip
        }
      }
    }
  }

  for (let i = 0; i < attRows.length; i += 1) {
    const r = attRows[i];
    const legacyId = String(r.userId);
    let emp = legacyToEmp.get(legacyId);
    if (!emp) {
      const u = userById.get(legacyId);
      const byName = u ? nameToMap.get(normalizeNameKey(u.name)) : null;
      if (byName) emp = empById.get(byName.new_mongo_id);
    }

    const date = blank(r.date).slice(0, 10);
    // Preserve second precision — NewHRMS UI / calc expect HH:MM:SS
    const check_in = toHHMMSS(r.checkIn);
    const check_out = toHHMMSS(r.checkOut);
    const brSec = breakSeconds(r.breaks);
    // Fractional minutes (second precision), matching attendanceCalc / helpers
    const break_total = Math.round((brSec / 60) * 10000) / 10000;
    let working_hours =
      Math.round(((Number(r.totalWorkedSeconds) || 0) / 3600) * 10000) / 10000;

    const bucket = ensureEmpBucket(legacyId, emp, blank(r.userName));
    const mgmt = r.managementOvertime || null;
    const mgmtMins = Number(mgmt?.durationMinutes) || 0;

    bucket.attendance.push({
      date,
      check_in: toHHMMSS(r.checkIn) || check_in || '',
      check_out: toHHMMSS(r.checkOut) || check_out || '',
      break_count: Array.isArray(r.breaks) ? r.breaks.length : 0,
      break_total_minutes: break_total,
      break_total_hm: secondsToHm(brSec),
      breaks_detail: formatBreaksDetail(r.breaks),
      worked_seconds: Number(r.totalWorkedSeconds) || 0,
      worked_hours_display: secondsToHms(Number(r.totalWorkedSeconds) || 0),
      working_hours,
      low_time: !!r.lowTimeFlag,
      extra_time: !!r.extraTimeFlag,
      is_manual: !!r.isManualFlag,
      management_ot_minutes: mgmtMins,
      management_ot_status: blank(mgmt?.status),
      management_ot_reason: blank(mgmt?.reason),
      mapped: !!emp,
    });

    if (mgmtMins > 0) {
      bucket.overtime.push({
        date,
        source: 'managementOvertime',
        hours: Math.round((mgmtMins / 60) * 10000) / 10000,
        minutes: mgmtMins,
        status: mapOtStatus(mgmt?.status),
        reason: blank(mgmt?.reason) || 'Management OT',
        apply: mapOtStatus(mgmt?.status) === 'Approved',
      });
    }

    if (!emp || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      attSkipped += 1;
      bar.update(i + 1);
      continue;
    }

    const threshold = await thresholdFor(emp._id);
    // Open break in legacy = break with start and no end
    const openBreak = Array.isArray(r.breaks)
      ? r.breaks.find((b) => b?.start && !b?.end)
      : null;
    const break_started_at = openBreak ? toHHMMSS(openBreak.start) : null;

    let status;
    let surplus_shortfall;
    if (check_in && !check_out) {
      status = break_started_at ? 'OnBreak' : 'Working';
      surplus_shortfall = 0;
      working_hours = 0;
    } else if (!check_in) {
      status = 'Absent';
      surplus_shortfall = 0;
      working_hours = 0;
    } else {
      const computed = computeDailyStatus(working_hours, threshold);
      status = computed.status;
      surplus_shortfall = computed.surplus_shortfall;
    }

    ops.push({
      updateOne: {
        filter: { employee_id: emp._id, date },
        update: {
          $set: {
            employee_id: emp._id,
            date,
            check_in,
            check_out,
            break_total,
            break_started_at: check_out ? null : break_started_at,
            working_hours,
            status,
            surplus_shortfall,
          },
        },
        upsert: true,
      },
    });

    if (DRY_RUN) attUpserted += 1;

    const [y, m] = date.split('-').map(Number);
    monthKeys.add(`${emp._id}|${m}|${y}`);
    touchedEmpIds.add(String(emp._id));

    if (ops.length >= 100) await flushAtt();
    if ((i + 1) % 20 === 0 || i + 1 === attRows.length) bar.update(i + 1);
  }
  await flushAtt();
  bar.stop();
  console.log(`Attendance upserted: ${attUpserted}, skipped: ${attSkipped}`);

  // ---- Leaves ----
  const touchedObjectIds = [...touchedEmpIds]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  // Also touch employees who only have leaves in range
  for (const lv of leaveInRange) {
    const emp =
      legacyToEmp.get(String(lv.userId)) ||
      empById.get(nameToMap.get(normalizeNameKey(lv.userName))?.new_mongo_id);
    if (emp && !touchedEmpIds.has(String(emp._id))) {
      touchedEmpIds.add(String(emp._id));
      touchedObjectIds.push(emp._id);
    }
  }

  if (!DRY_RUN && touchedObjectIds.length) {
    // Replace leaves that touch this window for mapped employees
    const del = await Leave.deleteMany({
      employee_id: { $in: touchedObjectIds },
      from_date: { $lte: TO },
      to_date: { $gte: FROM },
    });
    console.log(`Cleared overlapping NewHRMS leaves in range: ${del.deletedCount}`);
  }

  let leavesInserted = 0;
  let leavesSkipped = 0;
  const leaveDocs = [];

  for (const lv of leaveInRange) {
    const legacyId = String(lv.userId);
    let emp = legacyToEmp.get(legacyId);
    if (!emp) {
      const byN = nameToMap.get(normalizeNameKey(lv.userName));
      if (byN) emp = empById.get(byN.new_mongo_id);
    }

    const from_date = blank(lv.startDate).slice(0, 10);
    const to_date = blank(lv.endDate || lv.startDate).slice(0, 10);
    const cat = blank(lv.category);
    const reasonBase = blank(lv.reason);
    const status = mapLeaveStatus(lv.status);
    const day_type = mapLeaveDayType(cat);
    const reason =
      cat.toLowerCase().includes('extra time')
        ? `[Extra Time Leave] ${reasonBase}`.trim()
        : cat.toLowerCase().includes('unpaid')
          ? `[Unpaid] ${reasonBase}`.trim()
          : cat.toLowerCase().includes('paid') && !cat.toLowerCase().includes('unpaid')
            ? `[Paid] ${reasonBase}`.trim()
            : reasonBase;

    const bucket = ensureEmpBucket(legacyId, emp, blank(lv.userName));
    bucket.leaves.push({
      from_date,
      to_date,
      category: cat,
      day_type,
      reason: reasonBase,
      status,
      mapped: !!emp,
      importable: shouldImportLeave(cat),
    });

    if (!emp || !shouldImportLeave(cat)) {
      leavesSkipped += 1;
      continue;
    }

    leaveDocs.push({
      employee_id: emp._id,
      from_date,
      to_date,
      day_type,
      reason,
      status,
      applied_on: lv.createdAt ? new Date(lv.createdAt) : new Date(),
      approved_by: null,
      approved_on:
        status === 'Approved'
          ? lv.updatedAt
            ? new Date(lv.updatedAt)
            : new Date()
          : null,
    });

    const [y, m] = from_date.split('-').map(Number);
    monthKeys.add(`${emp._id}|${m}|${y}`);
  }

  if (!DRY_RUN && leaveDocs.length) {
    for (let i = 0; i < leaveDocs.length; i += 200) {
      const chunk = leaveDocs.slice(i, i + 200);
      await Leave.insertMany(chunk, { ordered: false });
      leavesInserted += chunk.length;
    }
  } else {
    leavesInserted = leaveDocs.length;
  }
  console.log(`Leaves inserted: ${leavesInserted}, skipped: ${leavesSkipped}`);

  // ---- Management OT (Approved) into overtime_requests ----
  if (!DRY_RUN && touchedObjectIds.length) {
    const delOt = await OvertimeRequest.deleteMany({
      employee_id: { $in: touchedObjectIds },
      date: { $gte: FROM, $lte: TO },
      ot_type: 'Management',
      reason: { $regex: /^\[Migrated management OT\]/ },
    });
    console.log(`Cleared prior migrated management OT in range: ${delOt.deletedCount}`);
  }

  let otInserted = 0;
  for (const bucket of reportByEmp.values()) {
    const employee = legacyToEmp.get(bucket.legacy_user_id);
    if (!employee) continue;
    for (const ot of bucket.overtime) {
      if (!ot.apply) continue;
      const hours = ot.hours;
      if (hours < 0.01) continue;
      const reason = `[Migrated management OT] ${ot.reason || 'Approved in legacy HRMS'}`;
      if (!DRY_RUN) {
        await OvertimeRequest.create({
          employee_id: employee._id,
          date: ot.date,
          hours,
          reason,
          status: 'Approved',
          ot_type: 'Management',
          applied_on: new Date(),
          decided_on: new Date(),
          decision_note: `Imported from hrms.attendances.managementOvertime (${FROM}..${TO})`,
        });
      }
      otInserted += 1;
      const [y, m] = ot.date.split('-').map(Number);
      monthKeys.add(`${employee._id}|${m}|${y}`);
    }
  }
  console.log(`Management OT requests inserted: ${otInserted}`);

  // ---- Monthly summaries ----
  const monthList = [...monthKeys].map((k) => {
    const [empId, m, y] = k.split('|');
    return { empId, month: Number(m), year: Number(y) };
  });
  console.log(`Recalculating monthly summaries: ${monthList.length}`);

  if (!DRY_RUN) {
    const sumBar = new cliProgress.SingleBar(
      {
        format: 'Summaries |{bar}| {percentage}% | {value}/{total}',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );
    sumBar.start(monthList.length, 0);
    for (let i = 0; i < monthList.length; i += 1) {
      const { empId, month, year } = monthList[i];
      try {
        await recalculateMonthlySummary(empId, month, year);
      } catch (e) {
        console.warn(`\nSummary failed ${empId} ${month}/${year}:`, e.message);
      }
      sumBar.update(i + 1);
    }
    sumBar.stop();
  }

  // ---- Write MD report ----
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const stamp = todayIstYmd();
  const mdPath = path.join(EXPORTS_DIR, `hrms_recent_days_${FROM}_to_${TO}_${stamp}.md`);
  const jsonPath = path.join(EXPORTS_DIR, `hrms_recent_days_${FROM}_to_${TO}_${stamp}.json`);

  const sorted = [...reportByEmp.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );

  const lines = [];
  lines.push(`# HRMS → NewHRMS recent days sync`);
  lines.push('');
  lines.push(`- **Source DB:** \`hrms\``);
  lines.push(`- **Target DB:** \`NewHRMS\``);
  lines.push(`- **Date range:** ${FROM} → ${TO} (inclusive)`);
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push(`- **Mode:** ${DRY_RUN ? 'dry-run (no writes)' : 'applied'}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|------:|`);
  lines.push(`| Employees in report | ${sorted.length} |`);
  lines.push(`| Attendance rows (source) | ${attRows.length} |`);
  lines.push(`| Attendance upserted | ${attUpserted} |`);
  lines.push(`| Attendance skipped (unmapped/bad) | ${attSkipped} |`);
  lines.push(`| Leaves overlapping range | ${leaveInRange.length} |`);
  lines.push(`| Leaves inserted | ${leavesInserted} |`);
  lines.push(`| Management OT inserted | ${otInserted} |`);
  lines.push(`| Monthly summaries recalculated | ${monthList.length} |`);
  lines.push('');

  for (const emp of sorted) {
    lines.push(`---`);
    lines.push('');
    lines.push(`## ${mdEscape(emp.name)}`);
    lines.push('');
    lines.push(`- **Employee code:** ${emp.employee_code || '—'}`);
    lines.push(`- **Email:** ${emp.email || '—'}`);
    lines.push(`- **Department:** ${emp.department || '—'}`);
    lines.push(`- **Legacy user id:** \`${emp.legacy_user_id}\``);
    lines.push(`- **Mapped to NewHRMS:** ${emp.mapped ? 'yes' : '**NO**'}`);
    lines.push('');

    lines.push(`### Attendance`);
    lines.push('');
    if (!emp.attendance.length) {
      lines.push('_No attendance rows in range._');
      lines.push('');
    } else {
      lines.push(
        `| Date | Check-in | Check-out | Break | Breaks detail | Worked | Flags | Mgmt OT |`
      );
      lines.push(
        `|------|----------|-----------|-------|---------------|--------|-------|---------|`
      );
      for (const a of emp.attendance.sort((x, y) => x.date.localeCompare(y.date))) {
        const flags = [
          a.low_time ? 'low' : '',
          a.extra_time ? 'extra' : '',
          a.is_manual ? 'manual' : '',
        ]
          .filter(Boolean)
          .join(', ') || '—';
        const mgmt =
          a.management_ot_minutes > 0
            ? `${a.management_ot_minutes}m (${a.management_ot_status || '?'})`
            : '—';
        lines.push(
          `| ${a.date} | ${a.check_in || '—'} | ${a.check_out || '—'} | ${a.break_total_hm} (${a.break_count}) | ${mdEscape(a.breaks_detail)} | ${a.worked_hours_display} | ${flags} | ${mgmt} |`
        );
      }
      lines.push('');
    }

    lines.push(`### Leaves`);
    lines.push('');
    if (!emp.leaves.length) {
      lines.push('_No leaves overlapping range._');
      lines.push('');
    } else {
      lines.push(`| From | To | Category | Day type | Status | Reason |`);
      lines.push(`|------|----|----------|----------|--------|--------|`);
      for (const lv of emp.leaves) {
        lines.push(
          `| ${lv.from_date} | ${lv.to_date} | ${mdEscape(lv.category)} | ${lv.day_type} | ${lv.status} | ${mdEscape(lv.reason)} |`
        );
      }
      lines.push('');
    }

    lines.push(`### Overtime (management)`);
    lines.push('');
    if (!emp.overtime.length) {
      lines.push('_No management OT in range._');
      lines.push('');
    } else {
      lines.push(`| Date | Hours | Status | Reason | Applied |`);
      lines.push(`|------|------:|--------|--------|---------|`);
      for (const ot of emp.overtime) {
        lines.push(
          `| ${ot.date} | ${ot.hours} | ${ot.status} | ${mdEscape(ot.reason)} | ${ot.apply ? 'yes' : 'no'} |`
        );
      }
      lines.push('');
    }
  }

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        from: FROM,
        to: TO,
        generated_at: new Date().toISOString(),
        dry_run: DRY_RUN,
        counts: {
          employees: sorted.length,
          attendance_source: attRows.length,
          attendance_upserted: attUpserted,
          attendance_skipped: attSkipped,
          leaves_source: leaveInRange.length,
          leaves_inserted: leavesInserted,
          ot_inserted: otInserted,
          summaries: monthList.length,
        },
        employees: sorted,
      },
      null,
      2
    ),
    'utf8'
  );

  // Verify target
  const attCount = await Attendance.countDocuments({ date: { $gte: FROM, $lte: TO } });
  const leaveCount = await Leave.countDocuments({
    from_date: { $lte: TO },
    to_date: { $gte: FROM },
  });
  const otCount = await OvertimeRequest.countDocuments({
    date: { $gte: FROM, $lte: TO },
    ot_type: 'Management',
  });

  console.log('\n=== Sync complete ===');
  console.log(`NewHRMS attendance ${FROM}..${TO}: ${attCount}`);
  console.log(`NewHRMS leaves overlapping:       ${leaveCount}`);
  console.log(`NewHRMS management OT in range:   ${otCount}`);
  console.log(`MD report:  ${mdPath}`);
  console.log(`JSON dump:  ${jsonPath}`);

  await hrmsConn.close();
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
