/**
 * Migrate May–August 2026 from MongoDB `hrms` → `NewHRMS` (data only, no schema changes).
 *
 * - Attendance, management OT, earlyLogoutRequest → EarlyCheckoutRequest
 * - Leaves from April 2026 onward: Full Day + Half Day forced to Unpaid (salary LOP)
 * - Recalculates monthly summaries (early checkout shortfall ↔ monthly working hours)
 * - Writes MD/JSON inventory BEFORE apply and a post-migrate verification report
 *
 * Usage:
 *   node scripts/migrateMayAugHrms.js --dry-run
 *   node scripts/migrateMayAugHrms.js
 *   node scripts/migrateMayAugHrms.js --from 2026-05-01 --to 2026-08-17
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
import EarlyCheckoutRequest from '../models/EarlyCheckoutRequest.js';
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
const UNPAID_FROM = '2026-04-01';

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

const FROM = argValue('--from', '2026-05-01');
const TO = argValue('--to', todayIstYmd());
/** Leaves include future applied dates (e.g. 26–27 Aug pending) — not limited to attendance TO. */
const LEAVE_TO = argValue('--leave-to', '2026-12-31');

function blank(v) {
  return String(v ?? '').trim();
}

function normalizeNameKey(name) {
  return blank(name).toLowerCase().replace(/\s+/g, ' ');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

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
    c.includes('extra time') ||
    c.includes('full')
  );
}

/** From April 2026: Full Day + Half Day → Unpaid. Extra Time Leave stays tagged Extra Time. */
function buildLeaveReason(category, reasonBase, fromDate) {
  const cat = blank(category);
  const reason = blank(reasonBase);
  const isExtra = /extra\s*time/i.test(cat);
  const forceUnpaid = fromDate >= UNPAID_FROM && !isExtra;
  if (isExtra) return `[Extra Time Leave] ${reason}`.trim();
  if (forceUnpaid) {
    // Strip prior Paid/Unpaid tags then force Unpaid
    const cleaned = reason.replace(/^\[(Paid|Unpaid)(\s*Leave)?\]\s*/i, '').trim();
    return `[Unpaid] ${cleaned}`.trim();
  }
  if (/unpaid/i.test(cat)) return `[Unpaid] ${reason}`.trim();
  if (/paid/i.test(cat) && !/unpaid/i.test(cat)) return `[Paid] ${reason}`.trim();
  return reason;
}

function mapEarlyStatus(s) {
  const v = blank(s).toLowerCase();
  if (v === 'approved') return 'Approved';
  if (v === 'rejected') return 'Rejected';
  if (v === 'pending') return 'Pending';
  if (v === 'cancelled' || v === 'canceled') return 'Cancelled';
  return null;
}

function datesOverlapRange(from, to, rangeFrom, rangeTo) {
  return from <= rangeTo && to >= rangeFrom;
}

function mdEscape(s) {
  return blank(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function ensureExportsDir() {
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

async function writePreMigrateReport(hrms, inventoryExtras = {}) {
  ensureExportsDir();
  const stamp = todayIstYmd();
  const months = ['2026-05', '2026-06', '2026-07', '2026-08'];
  const byMonth = {};
  for (const m of months) {
    byMonth[m] = {
      attendance: await hrms.collection('attendances').countDocuments({ date: { $regex: `^${m}` } }),
      leaves: await hrms.collection('leaverequests').countDocuments({ startDate: { $regex: `^${m}` } }),
      early_logout: await hrms.collection('attendances').countDocuments({
        date: { $regex: `^${m}` },
        earlyLogoutRequest: { $nin: ['None', null, ''] },
      }),
      management_ot: await hrms.collection('attendances').countDocuments({
        date: { $regex: `^${m}` },
        'managementOvertime.durationMinutes': { $gt: 0 },
        'managementOvertime.status': 'Approved',
      }),
    };
  }

  const earlyTotal = await hrms.collection('attendances').countDocuments({
    date: { $gte: FROM, $lte: TO },
    earlyLogoutRequest: { $nin: ['None', null, ''] },
  });
  const attTotal = await hrms.collection('attendances').countDocuments({
    date: { $gte: FROM, $lte: TO },
  });
  const leaveApr = await hrms.collection('leaverequests').find({}).toArray();
  const leavesInPolicy = leaveApr.filter((lv) => {
    const from = blank(lv.startDate).slice(0, 10);
    const to = blank(lv.endDate || lv.startDate).slice(0, 10);
    return from <= LEAVE_TO && to >= UNPAID_FROM;
  });

  const catCounts = {};
  for (const lv of leavesInPolicy) {
    const c = blank(lv.category) || '(blank)';
    catCounts[c] = (catCounts[c] || 0) + 1;
  }

  const payload = {
    generated_at: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run-pre' : 'pre-migrate',
    source_db: 'hrms',
    target_db: 'NewHRMS',
    attendance_range: { from: FROM, to: TO },
    leave_unpaid_from: UNPAID_FROM,
    by_month: byMonth,
    totals: {
      attendance: attTotal,
      early_logout_requests: earlyTotal,
      leaves_apr_to_to: leavesInPolicy.length,
      leave_categories: catCounts,
    },
    ...inventoryExtras,
  };

  const base = `pre_migrate_may_aug_${stamp}`;
  const jsonPath = path.join(EXPORTS_DIR, `${base}.json`);
  const mdPath = path.join(EXPORTS_DIR, `${base}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const md = [];
  md.push('# Pre-migration report: May–August (HRMS → NewHRMS)');
  md.push('');
  md.push(`- **Generated:** ${payload.generated_at}`);
  md.push(`- **Mode:** ${payload.mode}${DRY_RUN ? ' (dry-run — no writes yet)' : ''}`);
  md.push(`- **Source:** \`hrms\` → **Target:** \`NewHRMS\``);
  md.push(`- **Attendance / early-checkout / OT window:** ${FROM} → ${TO}`);
  md.push(`- **Leave unpaid policy:** from ${UNPAID_FROM} through ${LEAVE_TO} (includes future applied leaves)`);
  md.push(`- **Leave tagging:** Full Day + Half Day → \`[Unpaid]\``);
  md.push(`- **Schema changes:** none`);
  md.push('');
  md.push('## Source totals');
  md.push('');
  md.push('| Metric | Count |');
  md.push('|--------|------:|');
  md.push(`| Attendance rows | ${attTotal} |`);
  md.push(`| Early logout (Approved/Rejected/Pending) | ${earlyTotal} |`);
  md.push(`| Leaves overlapping ${UNPAID_FROM}→${LEAVE_TO} | ${leavesInPolicy.length} |`);
  md.push('');
  md.push('## By month (source)');
  md.push('');
  md.push('| Month | Attendance | Leaves | Early logout | Mgmt OT (Approved) |');
  md.push('|-------|----------:|-------:|-------------:|-------------------:|');
  for (const m of months) {
    const b = byMonth[m];
    md.push(`| ${m} | ${b.attendance} | ${b.leaves} | ${b.early_logout} | ${b.management_ot} |`);
  }
  md.push('');
  md.push('## Leave categories (Apr → TO)');
  md.push('');
  md.push('| Category | Count | Migrated as |');
  md.push('|----------|------:|-------------|');
  for (const [c, n] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
    const as =
      /extra\s*time/i.test(c)
        ? '[Extra Time Leave] (unchanged pay tag)'
        : '[Unpaid] Full/Half Day (forced from Apr)';
    md.push(`| ${mdEscape(c)} | ${n} | ${as} |`);
  }
  md.push('');
  md.push('## Early checkout ↔ monthly hours');
  md.push('');
  md.push(
    'Legacy `earlyLogoutRequest` is copied into NewHRMS `earlycheckoutrequests`. Early minutes for salary/monthly hours come from attendance `check_out` vs shift end; `recalculateMonthlySummary` folds low hours into monthly counted vs target hours.'
  );
  md.push('');
  md.push('## Migrate plan');
  md.push('');
  md.push('1. Upsert attendance (second precision check-in/out, breaks, worked hours).');
  md.push('2. Upsert EarlyCheckoutRequest from `earlyLogoutRequest` (link to NewHRMS attendance).');
  md.push('3. Replace leaves overlapping Apr→TO for mapped employees; force Unpaid on Full/Half Day.');
  md.push('4. Upsert Approved management OT as OvertimeRequest (Management).');
  md.push('5. Recalculate MonthlySummary for every touched employee-month.');
  md.push('6. Verify: 0 missing attendance / leaves / early-checkout vs source.');
  md.push('');

  fs.writeFileSync(mdPath, md.join('\n'));
  console.log(`Pre-migrate report: ${mdPath}`);
  return { mdPath, jsonPath, payload };
}

async function main() {
  console.log(
    `Migrate May–Aug hrms → NewHRMS ${FROM}..${TO}${DRY_RUN ? ' (DRY RUN)' : ''}`
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
  const nameToMap = new Map(mapRows.map((r) => [normalizeNameKey(r.name), r]));
  const legacyToMap = new Map(mapRows.map((r) => [r.legacy_user_id, r]));

  const hrmsConn = await mongoose.createConnection(uri, { dbName: 'hrms' }).asPromise();
  const hrms = hrmsConn.db;

  // ALWAYS write pre-migrate MD before any NewHRMS writes
  await writePreMigrateReport(hrms);

  await connectDB();

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
  console.log(`Mapped employees available: ${legacyToEmp.size}/${mapRows.length}`);

  function resolveEmp(legacyId, userName) {
    let emp = legacyToEmp.get(String(legacyId));
    if (emp) return emp;
    const byN = nameToMap.get(normalizeNameKey(userName));
    if (byN) emp = empById.get(byN.new_mongo_id);
    if (emp) legacyToEmp.set(String(legacyId), emp);
    return emp || null;
  }

  // ---- Attendance ----
  const attRows = await hrms
    .collection('attendances')
    .find({ date: { $gte: FROM, $lte: TO } })
    .sort({ date: 1, userId: 1 })
    .toArray();
  console.log(`Attendance source rows: ${attRows.length}`);

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

  let attUpserted = 0;
  let attSkipped = 0;
  const monthKeys = new Set();
  const touchedEmpIds = new Set();
  const ops = [];
  const earlyCandidates = []; // { emp, date, status, check_out, reason extras }

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
          // skip bad row
        }
      }
    }
  }

  for (let i = 0; i < attRows.length; i += 1) {
    const r = attRows[i];
    const emp = resolveEmp(r.userId, r.userName);
    const date = blank(r.date).slice(0, 10);
    const check_in = toHHMMSS(r.checkIn);
    const check_out = toHHMMSS(r.checkOut);
    const brSec = breakSeconds(r.breaks);
    const break_total = Math.round((brSec / 60) * 10000) / 10000;
    let working_hours =
      Math.round(((Number(r.totalWorkedSeconds) || 0) / 3600) * 10000) / 10000;

    const earlyStatus = mapEarlyStatus(r.earlyLogoutRequest);
    if (emp && earlyStatus) {
      earlyCandidates.push({
        emp,
        date,
        status: earlyStatus,
        check_out,
        check_in,
        earlyOvertime: r.earlyOvertime || null,
        userName: blank(r.userName),
      });
    }

    if (!emp || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      attSkipped += 1;
      bar.update(i + 1);
      continue;
    }

    const openBreak = Array.isArray(r.breaks)
      ? r.breaks.find((b) => b?.start && !b?.end)
      : null;
    const break_started_at = openBreak ? toHHMMSS(openBreak.start) : null;

    const threshold = await thresholdFor(emp._id);
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

  // ---- Early checkout requests ----
  const touchedObjectIds = [...touchedEmpIds]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (!DRY_RUN && touchedObjectIds.length) {
    const delEc = await EarlyCheckoutRequest.deleteMany({
      employee_id: { $in: touchedObjectIds },
      date: { $gte: FROM, $lte: TO },
      reason: { $regex: /^\[Migrated early logout\]/ },
    });
    console.log(`Cleared prior migrated early-checkout requests: ${delEc.deletedCount}`);
  }

  let earlyInserted = 0;
  let earlySkipped = 0;
  const attLookup = new Map(); // empId|date → attendance _id

  if (!DRY_RUN && earlyCandidates.length) {
    const dates = [...new Set(earlyCandidates.map((c) => c.date))];
    const empOids = [
      ...new Set(earlyCandidates.map((c) => String(c.emp._id))),
    ].map((id) => new mongoose.Types.ObjectId(id));
    const attDocs = await Attendance.find({
      employee_id: { $in: empOids },
      date: { $in: dates },
    })
      .select('_id employee_id date check_out')
      .lean();
    for (const a of attDocs) {
      attLookup.set(`${a.employee_id}|${a.date}`, a);
    }
  }

  const earlyDocs = [];
  for (const c of earlyCandidates) {
    const key = `${c.emp._id}|${c.date}`;
    const att = DRY_RUN
      ? { _id: new mongoose.Types.ObjectId(), check_out: c.check_out }
      : attLookup.get(key);
    if (!att) {
      earlySkipped += 1;
      continue;
    }
    const requested_time =
      c.check_out || att.check_out || c.check_in || '12:00:00';
    const otNote = c.earlyOvertime?.reason
      ? ` earlyOT=${blank(c.earlyOvertime.reason)}`
      : '';
    earlyDocs.push({
      employee_id: c.emp._id,
      attendance_id: att._id,
      date: c.date,
      requested_time,
      reason: `[Migrated early logout] status=${c.status}${otNote}`.trim(),
      status: c.status,
      decided_by: null,
      decided_at: c.status === 'Pending' ? null : new Date(),
      decision_note: 'Imported from hrms.attendances.earlyLogoutRequest',
    });
    const [y, m] = c.date.split('-').map(Number);
    monthKeys.add(`${c.emp._id}|${m}|${y}`);
  }

  if (!DRY_RUN && earlyDocs.length) {
    for (let i = 0; i < earlyDocs.length; i += 200) {
      const chunk = earlyDocs.slice(i, i + 200);
      await EarlyCheckoutRequest.insertMany(chunk, { ordered: false });
      earlyInserted += chunk.length;
    }
  } else {
    earlyInserted = earlyDocs.length;
  }
  console.log(
    `Early checkout requests: ${earlyInserted} inserted, ${earlySkipped} skipped (no att)`
  );

  // ---- Leaves (Apr → TO), force Unpaid on Full/Half Day ----
  const allLeaves = await hrms.collection('leaverequests').find({}).toArray();
  const leaveInRange = allLeaves.filter((lv) => {
    const from = blank(lv.startDate).slice(0, 10);
    const to = blank(lv.endDate || lv.startDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return false;
    return datesOverlapRange(from, to || from, UNPAID_FROM, LEAVE_TO);
  });
  console.log(`Leaves overlapping ${UNPAID_FROM}..${LEAVE_TO}: ${leaveInRange.length}`);

  for (const lv of leaveInRange) {
    const emp = resolveEmp(lv.userId, lv.userName);
    if (emp && !touchedEmpIds.has(String(emp._id))) {
      touchedEmpIds.add(String(emp._id));
      touchedObjectIds.push(emp._id);
    }
  }

  if (!DRY_RUN && touchedObjectIds.length) {
    const del = await Leave.deleteMany({
      employee_id: { $in: touchedObjectIds },
      from_date: { $lte: LEAVE_TO },
      to_date: { $gte: UNPAID_FROM },
    });
    console.log(`Cleared NewHRMS leaves overlapping ${UNPAID_FROM}→${LEAVE_TO}: ${del.deletedCount}`);
  }

  let leavesInserted = 0;
  let leavesSkipped = 0;
  const leaveDocs = [];

  for (const lv of leaveInRange) {
    const emp = resolveEmp(lv.userId, lv.userName);
    const from_date = blank(lv.startDate).slice(0, 10);
    const to_date = blank(lv.endDate || lv.startDate).slice(0, 10);
    const cat = blank(lv.category);
    if (!emp || !shouldImportLeave(cat)) {
      leavesSkipped += 1;
      continue;
    }
    const status = mapLeaveStatus(lv.status);
    const day_type = mapLeaveDayType(cat);
    const reason = buildLeaveReason(cat, blank(lv.reason), from_date);

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

    // Touch months across the leave span (including future months)
    const start = from_date < FROM ? FROM : from_date;
    const end = to_date;
    if (start <= end) {
      const [ys, ms] = start.split('-').map(Number);
      const [ye, me] = end.split('-').map(Number);
      let y = ys;
      let m = ms;
      while (y < ye || (y === ye && m <= me)) {
        monthKeys.add(`${emp._id}|${m}|${y}`);
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
    }
    // Also ensure April month summary if leave touches April
    if (from_date <= '2026-04-30' && to_date >= '2026-04-01') {
      monthKeys.add(`${emp._id}|4|2026`);
    }
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

  // ---- Management OT ----
  const mgmtRows = attRows.filter(
    (r) =>
      Number(r.managementOvertime?.durationMinutes) > 0 &&
      blank(r.managementOvertime?.status).toLowerCase() === 'approved'
  );

  if (!DRY_RUN && touchedObjectIds.length) {
    const delOt = await OvertimeRequest.deleteMany({
      employee_id: { $in: touchedObjectIds },
      date: { $gte: FROM, $lte: TO },
      ot_type: 'Management',
      reason: { $regex: /^\[Migrated management OT\]/ },
    });
    console.log(`Cleared prior migrated management OT: ${delOt.deletedCount}`);
  }

  let otInserted = 0;
  for (const r of mgmtRows) {
    const emp = resolveEmp(r.userId, r.userName);
    if (!emp) continue;
    const mins = Number(r.managementOvertime?.durationMinutes) || 0;
    if (mins < 1) continue;
    const hours = Math.round((mins / 60) * 10000) / 10000;
    const date = blank(r.date).slice(0, 10);
    const reason = `[Migrated management OT] ${blank(r.managementOvertime?.reason) || 'Approved in legacy HRMS'}`;
    if (!DRY_RUN) {
      await OvertimeRequest.create({
        employee_id: emp._id,
        date,
        hours,
        reason,
        status: 'Approved',
        ot_type: 'Management',
        applied_on: r.managementOvertime?.requestedAt
          ? new Date(r.managementOvertime.requestedAt)
          : new Date(),
        decided_on: r.managementOvertime?.approvedAt
          ? new Date(r.managementOvertime.approvedAt)
          : new Date(),
        decision_note: 'Imported from hrms.attendances.managementOvertime',
      });
    }
    otInserted += 1;
    const [y, m] = date.split('-').map(Number);
    monthKeys.add(`${emp._id}|${m}|${y}`);
  }
  console.log(`Management OT inserted: ${otInserted}`);

  // ---- Monthly summaries (early checkout shortfall ↔ monthly hours) ----
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

  // ---- Verify vs source ----
  const newConn = await mongoose.createConnection(uri, { dbName: 'NewHRMS' }).asPromise();
  const nh = newConn.db;

  let missingAtt = 0;
  let missingLeave = 0;
  let missingEarly = 0;
  const missingAttSamples = [];
  const missingLeaveSamples = [];
  const missingEarlySamples = [];

  for (const r of attRows) {
    const emp = resolveEmp(r.userId, r.userName);
    if (!emp) {
      missingAtt += 1;
      if (missingAttSamples.length < 20) {
        missingAttSamples.push({ date: r.date, userName: r.userName, reason: 'unmapped' });
      }
      continue;
    }
    if (DRY_RUN) continue;
    const found = await nh.collection('attendances').findOne({
      employee_id: emp._id,
      date: blank(r.date).slice(0, 10),
    });
    if (!found) {
      missingAtt += 1;
      if (missingAttSamples.length < 20) {
        missingAttSamples.push({ date: r.date, userName: r.userName, emp: emp.employee_id });
      }
    }
  }

  for (const lv of leaveInRange) {
    if (!shouldImportLeave(lv.category)) continue;
    const emp = resolveEmp(lv.userId, lv.userName);
    if (!emp) {
      missingLeave += 1;
      if (missingLeaveSamples.length < 20) {
        missingLeaveSamples.push({
          start: lv.startDate,
          userName: lv.userName,
          reason: 'unmapped',
        });
      }
      continue;
    }
    if (DRY_RUN) continue;
    const from_date = blank(lv.startDate).slice(0, 10);
    const to_date = blank(lv.endDate || lv.startDate).slice(0, 10);
    const day_type = mapLeaveDayType(lv.category);
    const found = await nh.collection('leaves').findOne({
      employee_id: emp._id,
      from_date,
      to_date,
      day_type,
      status: mapLeaveStatus(lv.status),
    });
    if (!found) {
      missingLeave += 1;
      if (missingLeaveSamples.length < 20) {
        missingLeaveSamples.push({
          start: from_date,
          userName: lv.userName,
          category: lv.category,
          status: lv.status,
        });
      }
    }
  }

  for (const c of earlyCandidates) {
    if (DRY_RUN) continue;
    const found = await nh.collection('earlycheckoutrequests').findOne({
      employee_id: c.emp._id,
      date: c.date,
      status: c.status,
      reason: { $regex: /^\[Migrated early logout\]/ },
    });
    if (!found) {
      missingEarly += 1;
      if (missingEarlySamples.length < 20) {
        missingEarlySamples.push({ date: c.date, userName: c.userName, status: c.status });
      }
    }
  }

  // Month counts
  const months = ['2026-05', '2026-06', '2026-07', '2026-08'];
  const verifyByMonth = {};
  for (const m of months) {
    verifyByMonth[m] = {
      hrms_att: await hrms.collection('attendances').countDocuments({ date: { $regex: `^${m}` } }),
      nh_att: await nh.collection('attendances').countDocuments({ date: { $regex: `^${m}` } }),
      hrms_leaves: await hrms.collection('leaverequests').countDocuments({
        startDate: { $regex: `^${m}` },
      }),
      nh_leaves: await nh.collection('leaves').countDocuments({ from_date: { $regex: `^${m}` } }),
      hrms_early: await hrms.collection('attendances').countDocuments({
        date: { $regex: `^${m}` },
        earlyLogoutRequest: { $nin: ['None', null, ''] },
      }),
      nh_early: await nh.collection('earlycheckoutrequests').countDocuments({
        date: { $regex: `^${m}` },
      }),
    };
  }

  const unpaidLeaves = DRY_RUN
    ? 0
    : await nh.collection('leaves').countDocuments({
        from_date: { $gte: UNPAID_FROM, $lte: LEAVE_TO },
        reason: { $regex: /\[Unpaid\]/i },
      });
  const paidLeft = DRY_RUN
    ? 0
    : await nh.collection('leaves').countDocuments({
        from_date: { $gte: UNPAID_FROM, $lte: LEAVE_TO },
        reason: { $regex: /\[Paid\]/i },
        day_type: { $in: ['Full Day', 'Half Day'] },
      });

  const report = {
    generated_at: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'applied',
    range: { from: FROM, to: TO },
    unpaid_from: UNPAID_FROM,
    results: {
      attendance_upserted: attUpserted,
      attendance_skipped: attSkipped,
      early_checkout_inserted: earlyInserted,
      early_checkout_skipped: earlySkipped,
      leaves_inserted: leavesInserted,
      leaves_skipped: leavesSkipped,
      management_ot_inserted: otInserted,
      monthly_summaries: monthList.length,
    },
    verify: {
      missing_attendance: missingAtt,
      missing_leaves: missingLeave,
      missing_early_checkout: missingEarly,
      unpaid_leaves_tagged: unpaidLeaves,
      paid_full_half_still_tagged: paidLeft,
      by_month: verifyByMonth,
      missing_att_samples: missingAttSamples,
      missing_leave_samples: missingLeaveSamples,
      missing_early_samples: missingEarlySamples,
    },
  };

  ensureExportsDir();
  const stamp = todayIstYmd();
  const postJson = path.join(EXPORTS_DIR, `post_migrate_may_aug_${stamp}.json`);
  const postMd = path.join(EXPORTS_DIR, `post_migrate_may_aug_${stamp}.md`);
  fs.writeFileSync(postJson, JSON.stringify(report, null, 2));

  const md = [];
  md.push('# Post-migration report: May–August (HRMS → NewHRMS)');
  md.push('');
  md.push(`- **Generated:** ${report.generated_at}`);
  md.push(`- **Mode:** ${report.mode}`);
  md.push(`- **Range:** ${FROM} → ${TO}`);
  md.push(`- **Unpaid leave policy from:** ${UNPAID_FROM}`);
  md.push('');
  md.push('## Applied counts');
  md.push('');
  md.push('| Metric | Count |');
  md.push('|--------|------:|');
  md.push(`| Attendance upserted | ${attUpserted} |`);
  md.push(`| Attendance skipped | ${attSkipped} |`);
  md.push(`| Early checkout inserted | ${earlyInserted} |`);
  md.push(`| Early checkout skipped | ${earlySkipped} |`);
  md.push(`| Leaves inserted | ${leavesInserted} |`);
  md.push(`| Leaves skipped | ${leavesSkipped} |`);
  md.push(`| Management OT | ${otInserted} |`);
  md.push(`| Monthly summaries recalculated | ${monthList.length} |`);
  md.push('');
  md.push('## Verification (0 missing target)');
  md.push('');
  md.push('| Check | Count |');
  md.push('|-------|------:|');
  md.push(`| Missing attendance | ${missingAtt} |`);
  md.push(`| Missing leaves | ${missingLeave} |`);
  md.push(`| Missing early checkout | ${missingEarly} |`);
  md.push(`| Leaves tagged [Unpaid] | ${unpaidLeaves} |`);
  md.push(`| Full/Half still tagged [Paid] (should be 0) | ${paidLeft} |`);
  md.push('');
  md.push('## By month after migrate');
  md.push('');
  md.push('| Month | HRMS att | NH att | HRMS leaves | NH leaves | HRMS early | NH early |');
  md.push('|-------|---------:|-------:|------------:|----------:|-----------:|---------:|');
  for (const m of months) {
    const b = verifyByMonth[m];
    md.push(
      `| ${m} | ${b.hrms_att} | ${b.nh_att} | ${b.hrms_leaves} | ${b.nh_leaves} | ${b.hrms_early} | ${b.nh_early} |`
    );
  }
  md.push('');
  if (missingAtt || missingLeave || missingEarly || paidLeft) {
    md.push('## Gaps');
    md.push('');
    if (missingAttSamples.length) {
      md.push('### Missing attendance samples');
      md.push('```json');
      md.push(JSON.stringify(missingAttSamples, null, 2));
      md.push('```');
    }
    if (missingLeaveSamples.length) {
      md.push('### Missing leave samples');
      md.push('```json');
      md.push(JSON.stringify(missingLeaveSamples, null, 2));
      md.push('```');
    }
    if (missingEarlySamples.length) {
      md.push('### Missing early checkout samples');
      md.push('```json');
      md.push(JSON.stringify(missingEarlySamples, null, 2));
      md.push('```');
    }
  } else {
    md.push('_All source rows present in NewHRMS. Unpaid policy applied. No schema changes._');
  }
  md.push('');
  fs.writeFileSync(postMd, md.join('\n'));

  console.log('\n=== Migration complete ===');
  console.log(JSON.stringify(report.results, null, 2));
  console.log('Verify:', JSON.stringify(report.verify, null, 2));
  console.log(`Post report: ${postMd}`);

  if (!DRY_RUN && (missingAtt || missingLeave || missingEarly || paidLeft)) {
    console.error('FAIL: missing data or paid tags remain');
    await hrmsConn.close();
    await newConn.close();
    await mongoose.disconnect();
    process.exit(1);
  }

  await hrmsConn.close();
  await newConn.close();
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
