/**
 * Remigrate August 2026 from MongoDB `hrms` → `NewHRMS`.
 *
 * Pipeline:
 *   1. snapshot  — fetch Aug data from hrms, store JSON + inventory MD
 *   2. wipe      — delete August records from NewHRMS + AuditLog
 *   3. import    — transform snapshot → NewHRMS schema + AuditLog + monthly summaries
 *   4. verify    — compare snapshot vs NewHRMS; write post-migrate MD
 *
 * Usage:
 *   node scripts/remigrateAugustHrms.js --dry-run
 *   node scripts/remigrateAugustHrms.js --phase all
 *   node scripts/remigrateAugustHrms.js --phase snapshot|wipe|import|verify
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
import CoverTimeRequest from '../models/CoverTimeRequest.js';
import MonthlySummary from '../models/MonthlySummary.js';
import AuditLog from '../models/AuditLog.js';
import { getEffectiveShiftForEmployee, computeDailyStatus } from '../services/shift.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';
import {
  extractGeneralOtFromAttendance,
  extractManagementOtFromAttendance,
} from './syncHrmsOvertime.js';

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
const SNAPSHOT_PATH = path.join(EXPORTS_DIR, 'hrms_august_2026_snapshot.json');
const INVENTORY_MD = path.join(EXPORTS_DIR, 'hrms_august_2026_inventory.md');
const POST_MD = path.join(EXPORTS_DIR, 'hrms_august_2026_post_migrate.md');

const DRY_RUN = process.argv.includes('--dry-run');
const FROM = '2026-08-01';
const TO = '2026-08-31';
const UNPAID_FROM = '2026-04-01';
const YEAR = 2026;
const MONTH = 8;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const PHASE = String(argValue('--phase', DRY_RUN ? 'snapshot' : 'all')).toLowerCase();

function blank(v) {
  return String(v ?? '').trim();
}

function normalizeNameKey(name) {
  return blank(name).toLowerCase().replace(/\s+/g, ' ');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayIstYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
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

function buildLeaveReason(category, reasonBase, fromDate) {
  const cat = blank(category);
  const reason = blank(reasonBase);
  const isExtra = /extra\s*time/i.test(cat);
  const forceUnpaid = fromDate >= UNPAID_FROM && !isExtra;
  if (isExtra) return `[Extra Time Leave] ${reason}`.trim();
  if (forceUnpaid) {
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

function clockKey(t) {
  if (!t) return null;
  return String(t).length === 5 ? `${t}:00` : String(t);
}

function ensureExportsDir() {
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

function loadMap() {
  if (!fs.existsSync(MAP_PATH)) {
    throw new Error(`Employee map missing: ${MAP_PATH}. Run migrate:hrms first.`);
  }
  return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    throw new Error(`Snapshot missing: ${SNAPSHOT_PATH}. Run --phase snapshot first.`);
  }
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

async function resolveAdminId() {
  const admin = await Employee.findOne({ role: 'admin' }).select('_id name').lean();
  if (!admin) throw new Error('No admin employee found in NewHRMS for AuditLog.performed_by');
  return admin._id;
}

function serializeForJson(docs) {
  return JSON.parse(
    JSON.stringify(docs, (_k, v) => {
      if (v && typeof v === 'object' && v._bsontype === 'ObjectID') return String(v);
      if (typeof v === 'bigint') return Number(v);
      return v;
    })
  );
}

// ─────────────────────────────────────────────────────────────
// Phase 1 — Snapshot
// ─────────────────────────────────────────────────────────────
async function phaseSnapshot(hrms) {
  console.log(`\n=== Phase 1: Snapshot hrms ${FROM}..${TO} ===`);
  ensureExportsDir();

  const attendances = await hrms
    .collection('attendances')
    .find({ date: { $gte: FROM, $lte: TO } })
    .sort({ date: 1, userId: 1 })
    .toArray();

  const allLeaves = await hrms.collection('leaverequests').find({}).toArray();
  const leaves = allLeaves.filter((lv) => {
    const from = blank(lv.startDate).slice(0, 10);
    const to = blank(lv.endDate || lv.startDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return false;
    return datesOverlapRange(from, to || from, FROM, TO);
  });

  let earlyLogout = 0;
  let managementOt = 0;
  let generalOt = 0;
  for (const r of attendances) {
    if (mapEarlyStatus(r.earlyLogoutRequest)) earlyLogout += 1;
    if (extractManagementOtFromAttendance(r)) managementOt += 1;
    if (extractGeneralOtFromAttendance(r)) generalOt += 1;
  }

  const catCounts = {};
  for (const lv of leaves) {
    const c = blank(lv.category) || '(blank)';
    catCounts[c] = (catCounts[c] || 0) + 1;
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    source_db: 'hrms',
    target_db: 'NewHRMS',
    range: { from: FROM, to: TO },
    counts: {
      attendances: attendances.length,
      leaves: leaves.length,
      early_logout: earlyLogout,
      management_ot: managementOt,
      general_ot: generalOt,
      leave_categories: catCounts,
    },
    attendances: serializeForJson(attendances),
    leaves: serializeForJson(leaves),
  };

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));

  const md = [];
  md.push('# August 2026 HRMS snapshot inventory');
  md.push('');
  md.push(`- **Generated:** ${snapshot.generated_at}`);
  md.push(`- **Mode:** ${DRY_RUN ? 'dry-run' : 'live'}`);
  md.push(`- **Source:** \`hrms\` → **Target:** \`NewHRMS\``);
  md.push(`- **Range:** ${FROM} → ${TO}`);
  md.push(`- **Snapshot file:** \`${path.basename(SNAPSHOT_PATH)}\``);
  md.push('');
  md.push('## Source totals');
  md.push('');
  md.push('| Metric | Count |');
  md.push('|--------|------:|');
  md.push(`| Attendance rows | ${attendances.length} |`);
  md.push(`| Leaves overlapping August | ${leaves.length} |`);
  md.push(`| Early logout requests | ${earlyLogout} |`);
  md.push(`| Management OT (Approved) | ${managementOt} |`);
  md.push(`| General OT | ${generalOt} |`);
  md.push('');
  md.push('## Leave categories');
  md.push('');
  md.push('| Category | Count |');
  md.push('|----------|------:|');
  for (const [c, n] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
    md.push(`| ${mdEscape(c)} | ${n} |`);
  }
  md.push('');
  md.push('## Next steps');
  md.push('');
  md.push('1. Wipe NewHRMS August records (`--phase wipe`)');
  md.push('2. Import from this snapshot (`--phase import`)');
  md.push('3. Verify (`--phase verify`)');
  md.push('');
  fs.writeFileSync(INVENTORY_MD, md.join('\n'));

  console.log(`Snapshot written: ${SNAPSHOT_PATH}`);
  console.log(`Inventory MD: ${INVENTORY_MD}`);
  console.log(
    `Counts — att:${attendances.length} leaves:${leaves.length} early:${earlyLogout} mgmtOT:${managementOt} genOT:${generalOt}`
  );

  return snapshot;
}

// ─────────────────────────────────────────────────────────────
// Phase 2 — Wipe
// ─────────────────────────────────────────────────────────────
async function phaseWipe() {
  console.log(`\n=== Phase 2: Wipe NewHRMS August ${FROM}..${TO} ===`);
  await connectDB();

  const dateFilter = { $gte: FROM, $lte: TO };
  const leaveFilter = { from_date: { $lte: TO }, to_date: { $gte: FROM } };
  const summaryFilter = { month: MONTH, year: YEAR };

  const planned = {
    attendance: await Attendance.countDocuments({ date: dateFilter }),
    leaves: await Leave.countDocuments(leaveFilter),
    overtime: await OvertimeRequest.countDocuments({ date: dateFilter }),
    early_checkout: await EarlyCheckoutRequest.countDocuments({ date: dateFilter }),
    cover_time: await CoverTimeRequest.countDocuments({ date: dateFilter }),
    monthly_summary: await MonthlySummary.countDocuments(summaryFilter),
  };
  console.log('Planned wipe counts:', planned);

  if (DRY_RUN) {
    console.log('DRY RUN — no deletes performed');
    return { dry_run: true, planned };
  }

  const att = await Attendance.deleteMany({ date: dateFilter });
  const leaves = await Leave.deleteMany(leaveFilter);
  const overtime = await OvertimeRequest.deleteMany({ date: dateFilter });
  const early = await EarlyCheckoutRequest.deleteMany({ date: dateFilter });
  const cover = await CoverTimeRequest.deleteMany({ date: dateFilter });
  const summaries = await MonthlySummary.deleteMany(summaryFilter);

  const details = {
    attendance_deleted: att.deletedCount,
    leaves_deleted: leaves.deletedCount,
    overtime_deleted: overtime.deletedCount,
    early_checkout_deleted: early.deletedCount,
    cover_time_deleted: cover.deletedCount,
    monthly_summary_deleted: summaries.deletedCount,
  };
  console.log('Deleted:', details);

  const performedBy = await resolveAdminId();
  await AuditLog.create({
    action: 'august_remigrate_wipe',
    performed_by: performedBy,
    details,
    date_range: { start: FROM, end: TO },
  });
  console.log('AuditLog: august_remigrate_wipe');

  return details;
}

// ─────────────────────────────────────────────────────────────
// Phase 3 — Import from snapshot
// ─────────────────────────────────────────────────────────────
async function phaseImport() {
  console.log(`\n=== Phase 3: Import from snapshot → NewHRMS ===`);
  const snapshot = loadSnapshot();
  const mapRows = loadMap();
  await connectDB();

  const nameToMap = new Map(mapRows.map((r) => [normalizeNameKey(r.name), r]));
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

  const attRows = snapshot.attendances || [];
  const leaveRows = snapshot.leaves || [];
  console.log(`Snapshot attendance: ${attRows.length}, leaves: ${leaveRows.length}`);

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
  const earlyCandidates = [];
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
      });
    }

    if (!emp || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      attSkipped += 1;
      bar.update(i + 1);
      continue;
    }

    const openBreak = Array.isArray(r.breaks) ? r.breaks.find((b) => b?.start && !b?.end) : null;
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

    monthKeys.add(`${emp._id}|${MONTH}|${YEAR}`);
    touchedEmpIds.add(String(emp._id));

    if (ops.length >= 100) await flushAtt();
    if ((i + 1) % 20 === 0 || i + 1 === attRows.length) bar.update(i + 1);
  }
  await flushAtt();
  bar.stop();
  console.log(`Attendance upserted: ${attUpserted}, skipped: ${attSkipped}`);

  // ---- Early checkout ----
  let earlyInserted = 0;
  let earlySkipped = 0;
  const attLookup = new Map();

  if (!DRY_RUN && earlyCandidates.length) {
    const dates = [...new Set(earlyCandidates.map((c) => c.date))];
    const empOids = [...new Set(earlyCandidates.map((c) => String(c.emp._id)))].map(
      (id) => new mongoose.Types.ObjectId(id)
    );
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
    const requested_time = c.check_out || att.check_out || c.check_in || '12:00:00';
    const otNote = c.earlyOvertime?.reason ? ` earlyOT=${blank(c.earlyOvertime.reason)}` : '';
    earlyDocs.push({
      employee_id: c.emp._id,
      attendance_id: att._id,
      date: c.date,
      requested_time,
      reason: `[Migrated early logout] status=${c.status}${otNote}`.trim(),
      status: c.status,
      decided_by: null,
      decided_at: c.status === 'Pending' ? null : new Date(),
      decision_note: 'Imported from hrms.attendances.earlyLogoutRequest (Aug 2026 remigrate)',
    });
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
  console.log(`Early checkout: ${earlyInserted} inserted, ${earlySkipped} skipped`);

  // ---- Leaves ----
  for (const lv of leaveRows) {
    const emp = resolveEmp(lv.userId, lv.userName);
    if (emp) touchedEmpIds.add(String(emp._id));
  }

  let leavesInserted = 0;
  let leavesSkipped = 0;
  const leaveDocs = [];

  for (const lv of leaveRows) {
    const emp = resolveEmp(lv.userId, lv.userName);
    const from_date = blank(lv.startDate).slice(0, 10);
    const to_date = blank(lv.endDate || lv.startDate).slice(0, 10);
    const cat = blank(lv.category);
    if (!emp || !shouldImportLeave(cat)) {
      leavesSkipped += 1;
      continue;
    }
    const status = mapLeaveStatus(lv.status);
    leaveDocs.push({
      employee_id: emp._id,
      from_date,
      to_date,
      day_type: mapLeaveDayType(cat),
      reason: buildLeaveReason(cat, blank(lv.reason), from_date),
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
    monthKeys.add(`${emp._id}|${MONTH}|${YEAR}`);
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

  // ---- Overtime (general + management) ----
  const otDocs = [];
  let generalOt = 0;
  let managementOt = 0;

  for (const r of attRows) {
    const emp = resolveEmp(r.userId, r.userName);
    if (!emp) continue;
    const date = blank(r.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const general = extractGeneralOtFromAttendance(r);
    if (general) {
      otDocs.push({
        employee_id: emp._id,
        date,
        hours: general.hours,
        reason: `[Migrated general OT] ${general.reason}`,
        status: general.status,
        ot_type: general.ot_type,
        applied_on: general.applied_on,
        decided_on: general.decided_on,
        decision_note: 'Imported from hrms.attendances.overtimeRequest (Aug 2026 remigrate)',
      });
      generalOt += 1;
      monthKeys.add(`${emp._id}|${MONTH}|${YEAR}`);
      touchedEmpIds.add(String(emp._id));
    }

    const mgmt = extractManagementOtFromAttendance(r);
    if (mgmt) {
      otDocs.push({
        employee_id: emp._id,
        date,
        hours: mgmt.hours,
        reason: `[Migrated management OT] ${mgmt.reason}`,
        status: mgmt.status,
        ot_type: mgmt.ot_type,
        applied_on: mgmt.applied_on,
        decided_on: mgmt.decided_on,
        decision_note: 'Imported from hrms.attendances.managementOvertime (Aug 2026 remigrate)',
      });
      managementOt += 1;
      monthKeys.add(`${emp._id}|${MONTH}|${YEAR}`);
      touchedEmpIds.add(String(emp._id));
    }
  }

  let otInserted = 0;
  if (!DRY_RUN && otDocs.length) {
    for (let i = 0; i < otDocs.length; i += 200) {
      const chunk = otDocs.slice(i, i + 200);
      await OvertimeRequest.insertMany(chunk, { ordered: false });
      otInserted += chunk.length;
    }
  } else {
    otInserted = otDocs.length;
  }
  console.log(
    `OT inserted: ${otInserted} (general=${generalOt}, management=${managementOt})`
  );

  // ---- Monthly summaries ----
  // Recalculate for every mapped employee for August (covers wipe + reimport)
  const empIdsForSummary = [
    ...new Set([
      ...[...monthKeys].map((k) => k.split('|')[0]),
      ...[...touchedEmpIds],
      ...employees.map((e) => String(e._id)),
    ]),
  ].filter((id) => mongoose.isValidObjectId(id));

  console.log(`Recalculating August monthly summaries: ${empIdsForSummary.length}`);
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
    sumBar.start(empIdsForSummary.length, 0);
    for (let i = 0; i < empIdsForSummary.length; i += 1) {
      try {
        await recalculateMonthlySummary(empIdsForSummary[i], MONTH, YEAR);
      } catch (err) {
        console.warn(`Summary failed for ${empIdsForSummary[i]}: ${err.message}`);
      }
      sumBar.update(i + 1);
    }
    sumBar.stop();
  }

  const details = {
    attendance_upserted: attUpserted,
    attendance_skipped: attSkipped,
    leaves_inserted: leavesInserted,
    leaves_skipped: leavesSkipped,
    early_checkout_inserted: earlyInserted,
    early_checkout_skipped: earlySkipped,
    overtime_inserted: otInserted,
    general_ot: generalOt,
    management_ot: managementOt,
    summaries_recalculated: empIdsForSummary.length,
    dry_run: DRY_RUN,
  };
  console.log('Import details:', details);

  if (!DRY_RUN) {
    const performedBy = await resolveAdminId();
    await AuditLog.create({
      action: 'august_remigrate_import',
      performed_by: performedBy,
      details,
      date_range: { start: FROM, end: TO },
    });
    console.log('AuditLog: august_remigrate_import');
  }

  return details;
}

// ─────────────────────────────────────────────────────────────
// Phase 4 — Verify
// ─────────────────────────────────────────────────────────────
async function phaseVerify() {
  console.log(`\n=== Phase 4: Verify snapshot ↔ NewHRMS ===`);
  const snapshot = loadSnapshot();
  const mapRows = loadMap();
  await connectDB();

  const legacyToNew = new Map(mapRows.map((r) => [r.legacy_user_id, r]));
  const srcAtt = snapshot.attendances || [];
  const srcLeaves = snapshot.leaves || [];

  const dstAtt = await Attendance.find({ date: { $gte: FROM, $lte: TO } }).lean();
  const dstByKey = new Map(dstAtt.map((a) => [`${a.employee_id}|${a.date}`, a]));

  let expectedMappedAtt = 0;
  let missing = 0;
  let timeMismatch = 0;
  let secondsLost = 0;
  let breakMismatch = 0;
  let statusIssues = 0;
  const samples = [];

  for (const r of srcAtt) {
    const mapRow = legacyToNew.get(String(r.userId));
    if (!mapRow) continue;
    expectedMappedAtt += 1;
    const d = dstByKey.get(`${mapRow.new_mongo_id}|${blank(r.date).slice(0, 10)}`);
    if (!d) {
      missing += 1;
      if (samples.length < 15) samples.push({ type: 'missing', name: mapRow.name, date: r.date });
      continue;
    }

    const inSrc = toHHMMSS(r.checkIn);
    const outSrc = toHHMMSS(r.checkOut);
    const open = (r.breaks || []).find((b) => b?.start && !b?.end);

    if (inSrc && d.check_in) {
      if (clockKey(d.check_in) !== inSrc) {
        if (String(d.check_in).length === 5 && inSrc.startsWith(d.check_in)) secondsLost += 1;
        else {
          timeMismatch += 1;
          if (samples.length < 15) {
            samples.push({
              type: 'check_in',
              name: mapRow.name,
              date: r.date,
              src: inSrc,
              dst: d.check_in,
            });
          }
        }
      }
    }
    if (outSrc && d.check_out) {
      if (clockKey(d.check_out) !== outSrc) {
        if (String(d.check_out).length === 5 && outSrc.startsWith(d.check_out)) secondsLost += 1;
        else {
          timeMismatch += 1;
          if (samples.length < 15) {
            samples.push({
              type: 'check_out',
              name: mapRow.name,
              date: r.date,
              src: outSrc,
              dst: d.check_out,
            });
          }
        }
      }
    } else if (!!outSrc !== !!d.check_out) {
      timeMismatch += 1;
      if (samples.length < 15) {
        samples.push({
          type: 'check_out_null',
          name: mapRow.name,
          date: r.date,
          src: outSrc,
          dst: d.check_out,
        });
      }
    }

    const brMin = Math.round((breakSeconds(r.breaks) / 60) * 10000) / 10000;
    const dstBr = Number(d.break_total || 0);
    if (Math.abs(Math.round(brMin) - Math.round(dstBr)) > 0 && !(open && Math.abs(brMin - dstBr) <= 1)) {
      breakMismatch += 1;
      if (samples.length < 15) {
        samples.push({
          type: 'break',
          name: mapRow.name,
          date: r.date,
          src: brMin,
          dst: dstBr,
          open: !!open,
        });
      }
    }

    if (open && d.status !== 'OnBreak') {
      statusIssues += 1;
      if (samples.length < 15) {
        samples.push({
          type: 'status-open',
          name: mapRow.name,
          date: r.date,
          dstStatus: d.status,
        });
      }
    } else if (d.check_in && !d.check_out && !open && !d.break_started_at && d.status !== 'Working') {
      statusIssues += 1;
    }
  }

  // Expected importable leaves (mapped + shouldImportLeave)
  let expectedLeaves = 0;
  for (const lv of srcLeaves) {
    const mapRow = legacyToNew.get(String(lv.userId));
    if (!mapRow) continue;
    if (!shouldImportLeave(blank(lv.category))) continue;
    expectedLeaves += 1;
  }
  const dstLeaves = await Leave.countDocuments({
    from_date: { $lte: TO },
    to_date: { $gte: FROM },
  });

  let expectedEarly = 0;
  let expectedGenOt = 0;
  let expectedMgmtOt = 0;
  for (const r of srcAtt) {
    if (!legacyToNew.get(String(r.userId))) continue;
    if (mapEarlyStatus(r.earlyLogoutRequest)) expectedEarly += 1;
    if (extractGeneralOtFromAttendance(r)) expectedGenOt += 1;
    if (extractManagementOtFromAttendance(r)) expectedMgmtOt += 1;
  }
  const dstEarly = await EarlyCheckoutRequest.countDocuments({
    date: { $gte: FROM, $lte: TO },
  });
  const dstOt = await OvertimeRequest.countDocuments({ date: { $gte: FROM, $lte: TO } });
  const dstSummaries = await MonthlySummary.countDocuments({ month: MONTH, year: YEAR });

  const attDelta = Math.abs(expectedMappedAtt - dstAtt.length);
  const leaveDelta = Math.abs(expectedLeaves - dstLeaves);
  const earlyDelta = Math.abs(expectedEarly - dstEarly);
  const otDelta = Math.abs(expectedGenOt + expectedMgmtOt - dstOt);

  const ok =
    missing === 0 &&
    timeMismatch === 0 &&
    statusIssues === 0 &&
    secondsLost === 0 &&
    attDelta === 0 &&
    leaveDelta === 0 &&
    earlyDelta === 0 &&
    otDelta === 0;

  const report = {
    generated_at: new Date().toISOString(),
    range: { from: FROM, to: TO },
    snapshot_counts: snapshot.counts,
    expected: {
      attendance_mapped: expectedMappedAtt,
      leaves_importable: expectedLeaves,
      early_checkout: expectedEarly,
      general_ot: expectedGenOt,
      management_ot: expectedMgmtOt,
    },
    newhrms: {
      attendance: dstAtt.length,
      leaves: dstLeaves,
      early_checkout: dstEarly,
      overtime: dstOt,
      monthly_summaries: dstSummaries,
    },
    fidelity: {
      missing,
      timeMismatch,
      secondsLost,
      breakMismatch,
      statusIssues,
      attDelta,
      leaveDelta,
      earlyDelta,
      otDelta,
    },
    samples,
    ok,
  };

  ensureExportsDir();
  const md = [];
  md.push('# August 2026 remigration — post-verify');
  md.push('');
  md.push(`- **Generated:** ${report.generated_at}`);
  md.push(`- **Range:** ${FROM} → ${TO}`);
  md.push(`- **Result:** ${ok ? 'PASS' : 'FAIL'}`);
  md.push('');
  md.push('## Counts');
  md.push('');
  md.push('| Metric | Expected (mapped) | NewHRMS | Delta |');
  md.push('|--------|------------------:|--------:|------:|');
  md.push(`| Attendance | ${expectedMappedAtt} | ${dstAtt.length} | ${attDelta} |`);
  md.push(`| Leaves | ${expectedLeaves} | ${dstLeaves} | ${leaveDelta} |`);
  md.push(`| Early checkout | ${expectedEarly} | ${dstEarly} | ${earlyDelta} |`);
  md.push(
    `| Overtime | ${expectedGenOt + expectedMgmtOt} | ${dstOt} | ${otDelta} |`
  );
  md.push(`| Monthly summaries | — | ${dstSummaries} | — |`);
  md.push('');
  md.push('## Fidelity');
  md.push('');
  md.push('| Check | Count |');
  md.push('|-------|------:|');
  md.push(`| Missing attendance | ${missing} |`);
  md.push(`| Time mismatch | ${timeMismatch} |`);
  md.push(`| Seconds lost | ${secondsLost} |`);
  md.push(`| Break mismatch | ${breakMismatch} |`);
  md.push(`| Status issues | ${statusIssues} |`);
  md.push('');
  if (samples.length) {
    md.push('## Samples');
    md.push('');
    md.push('```json');
    md.push(JSON.stringify(samples, null, 2));
    md.push('```');
    md.push('');
  }
  fs.writeFileSync(POST_MD, md.join('\n'));
  console.log(`Post-migrate report: ${POST_MD}`);
  console.log(JSON.stringify(report, null, 2));

  if (!ok) {
    const err = new Error('August remigration verification FAILED');
    err.report = report;
    throw err;
  }
  return report;
}

// ─────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `August remigrate hrms → NewHRMS ${FROM}..${TO} | phase=${PHASE}${DRY_RUN ? ' (DRY RUN)' : ''}`
  );

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI required');
  loadMap(); // fail fast if map missing

  const runSnapshot = PHASE === 'all' || PHASE === 'snapshot' || DRY_RUN;
  const runWipe = !DRY_RUN && (PHASE === 'all' || PHASE === 'wipe');
  const runImport = !DRY_RUN && (PHASE === 'all' || PHASE === 'import');
  // dry-run still runs snapshot; optionally count wipe plans when phase all/wipe
  const runWipePlan = DRY_RUN && (PHASE === 'all' || PHASE === 'wipe' || PHASE === 'snapshot');
  const runVerify = !DRY_RUN && (PHASE === 'all' || PHASE === 'verify');

  let hrmsConn = null;
  try {
    if (runSnapshot) {
      hrmsConn = await mongoose.createConnection(uri, { dbName: 'hrms' }).asPromise();
      await phaseSnapshot(hrmsConn.db);
    }

    if (runWipe || runWipePlan) {
      await phaseWipe();
    }

    if (runImport) {
      await phaseImport();
    } else if (DRY_RUN && (PHASE === 'all' || PHASE === 'import')) {
      console.log('\nDRY RUN — skipping import writes (transform would use snapshot)');
      const snap = loadSnapshot();
      console.log(
        `Would import att=${snap.counts.attendances} leaves=${snap.counts.leaves} early=${snap.counts.early_logout} ot=${snap.counts.management_ot + snap.counts.general_ot}`
      );
    }

    if (runVerify) {
      await phaseVerify();
    }

    console.log('\nDone.');
  } finally {
    if (hrmsConn) await hrmsConn.close().catch(() => {});
    if (mongoose.connection.readyState === 1) await mongoose.disconnect().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(e.message?.includes('verification FAILED') ? 2 : 1);
});
