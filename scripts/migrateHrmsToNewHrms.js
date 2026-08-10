/**
 * Migrate employees / HR / admin (+ attendance, leaves, management OT)
 * from MongoDB `hrms` → `NewHRMS` without changing NewHRMS schemas.
 *
 * Cutoff: attendance & leave start dates through 2026-08-09 (inclusive).
 *
 * Usage:
 *   node scripts/migrateHrmsToNewHrms.js
 *   node scripts/migrateHrmsToNewHrms.js --dry-run
 */
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';

import { connectDB } from '../config/db.js';
import Department from '../models/Department.js';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import OvertimeRequest from '../models/OvertimeRequest.js';
import SystemSettings from '../models/SystemSettings.js';
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
const CUTOFF = '2026-08-09';
const DRY_RUN = process.argv.includes('--dry-run');
const DEFAULT_PASSWORD = 'hrms@123';

const DEPT_DEFAULTS = {
  AI: { working_hours_per_day: 8.25, shift_start: '08:45', shift_end: '17:30' },
  Web: { working_hours_per_day: 8.25, shift_start: '08:45', shift_end: '17:30' },
  SEO: { working_hours_per_day: 8.25, shift_start: '10:00', shift_end: '18:30' },
  Sales: { working_hours_per_day: 8.25, shift_start: '09:00', shift_end: '18:00' },
  'Marketing & Sales': { working_hours_per_day: 8.25, shift_start: '09:00', shift_end: '18:00' },
  HR: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  Admin: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  Design: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  CEO: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  IT: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
  Engineering: { working_hours_per_day: 8.25, shift_start: '09:30', shift_end: '18:30' },
};

/** Obvious sandbox / duplicate junk in legacy hrms.users */
const SKIP_NAME_RE =
  /^(admin2|secondary admin|test|test admin|hr|john|het|jamin|rahul|raj|rajkumar|priti|ujaval|vandit|charlie dev|kaushik vaghasiya2|rupesh garsondiya)$/i;

function blank(v) {
  return String(v ?? '').trim();
}

function normalizeDept(name) {
  const n = blank(name);
  if (!n) return 'IT';
  const key = n.toLowerCase();
  if (key === 'web') return 'Web';
  if (key === 'seo') return 'SEO';
  if (key === 'ai') return 'AI';
  if (key === 'hr') return 'HR';
  if (key === 'it') return 'IT';
  if (key === 'design') return 'Design';
  if (key === 'sales executive' || key === 'sales') return 'Sales';
  if (key === 'marketing & sales') return 'Marketing & Sales';
  if (key === 'admin') return 'Admin';
  if (key === 'engineering') return 'Engineering';
  if (key === 'ceo') return 'CEO';
  return n;
}

function normalizeRole(role) {
  const r = blank(role).toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'hr') return 'hr';
  return 'employee';
}

function normalizeNameKey(name) {
  return blank(name).toLowerCase().replace(/\s+/g, ' ');
}

function slugName(name) {
  return (
    blank(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '.')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 40) || 'user'
  );
}

/** Parse DD-MM-YYYY or ISO → Date or null */
function parseLegacyDate(v) {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  const s = blank(v);
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) {
    const d = new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

function toYmd(d) {
  if (!d) return null;
  const x = d instanceof Date ? d : parseLegacyDate(d);
  if (!x) return null;
  return x.toISOString().slice(0, 10);
}

/** UTC ISO datetime → local IST HH:MM (Asia/Kolkata = +05:30) */
function toHHMM(v) {
  if (v == null || v === '') return null;
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === 'string' && v.includes('T')) d = new Date(v);
  else if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (m) return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
    d = new Date(v);
  } else return null;
  if (Number.isNaN(d.getTime())) return null;
  // Format in Asia/Kolkata
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === 'hour')?.value;
  const mm = parts.find((p) => p.type === 'minute')?.value;
  if (hh == null || mm == null) return null;
  return `${hh}:${mm}`;
}

function breakMinutes(breaks) {
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
  return Math.round(sec / 60);
}

function isTestUser(u) {
  const name = blank(u.name);
  const email = blank(u.email).toLowerCase();
  const username = blank(u.username).toLowerCase();
  if (SKIP_NAME_RE.test(name)) return true;
  if (SKIP_NAME_RE.test(username)) return true;
  // Single-token IT sandbox accounts with non-company emails
  if (
    !name.includes(' ') &&
    /@(gmail|example|test)\.com$/i.test(email) &&
    normalizeRole(u.role) === 'employee'
  ) {
    return true;
  }
  if (email === 'charlie@krira.ai' || email === 'admin2@krira.ai') return true;
  return false;
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
  // Extra Time Leave is an old-system OT offset — keep as leave with tagged reason
  return (
    c.includes('paid') ||
    c.includes('unpaid') ||
    c.includes('half') ||
    c.includes('extra time')
  );
}

async function ensureDepartments(names) {
  const map = new Map();
  for (const raw of names) {
    const name = normalizeDept(raw);
    let doc = await Department.findOne({ name });
    if (!doc) {
      const def = DEPT_DEFAULTS[name] || {
        working_hours_per_day: 8.25,
        shift_start: '09:30',
        shift_end: '18:30',
      };
      if (DRY_RUN) {
        console.log(`[dry-run] would create department ${name}`);
        map.set(name, { _id: new mongoose.Types.ObjectId(), name, ...def });
        continue;
      }
      doc = await Department.create({ name, status: 'active', ...def });
      console.log(`Created department: ${name}`);
    }
    map.set(name, doc);
  }
  return map;
}

async function nextEmployeeCode() {
  const rows = await Employee.find({ employee_id: /^EMP-\d{4}-\d+$/ })
    .select('employee_id')
    .lean();
  let max = 0;
  for (const r of rows) {
    const m = String(r.employee_id).match(/EMP-\d{4}-(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function pickUniqueUsers(users) {
  /** Prefer active, then newest updatedAt, one per normalized name */
  const byName = new Map();
  for (const u of users) {
    if (isTestUser(u)) continue;
    const key = normalizeNameKey(u.name);
    if (!key) continue;
    // Collapse "admin" / "Admin" into one key already via normalize
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, u);
      continue;
    }
    const score = (x) => (x.isActive ? 2 : 0) + (x.lastLogin ? 1 : 0);
    if (score(u) > score(prev)) byName.set(key, u);
    else if (score(u) === score(prev)) {
      const tu = new Date(u.updatedAt || 0).getTime();
      const tp = new Date(prev.updatedAt || 0).getTime();
      if (tu >= tp) byName.set(key, u);
    }
  }
  return [...byName.values()];
}

function mapBonds(bonds) {
  if (!Array.isArray(bonds)) return [];
  return bonds.map((b) => {
    const start = parseLegacyDate(b.startDate);
    const end = parseLegacyDate(b.endDate);
    let status = 'Active';
    if (end && end.getTime() < Date.now()) status = 'Completed';
    return {
      type: blank(b.type) || 'Job',
      start_date: start,
      end_date: end,
      period_months: Number(b.periodMonths) || 12,
      amount: Number(b.amount) || 0,
      status,
      notes: '',
      proof_type: '',
      proof_status: '',
      proof_returned_date: null,
      salary_deduction_percent: 15,
    };
  });
}

function mapSalarySchedule(breakdown) {
  if (!Array.isArray(breakdown)) return [];
  return breakdown.map((s, i) => ({
    start_date: toYmd(s.startDate),
    end_date: toYmd(s.endDate),
    monthly_salary: Number(s.amount) || 0,
    label: blank(s.bondType) || '',
    step_index: i,
  }));
}

function currentBaseSalary(breakdown) {
  if (!Array.isArray(breakdown) || !breakdown.length) return 0;
  // Prefer current calendar month band; else last non-zero; else last
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
  const cur = breakdown.find((s) => s.year === now.getUTCFullYear() && s.month === now.getUTCMonth() + 1);
  if (cur && Number(cur.amount) > 0) return Number(cur.amount);
  const nonzero = [...breakdown].reverse().find((s) => Number(s.amount) > 0);
  if (nonzero) return Number(nonzero.amount);
  return Number(breakdown[breakdown.length - 1]?.amount) || 0;
}

async function main() {
  console.log(`Migrating hrms → NewHRMS through ${CUTOFF}${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI required');

  // Source (legacy)
  const hrmsConn = await mongoose.createConnection(uri, { dbName: 'hrms' }).asPromise();
  const hrms = hrmsConn.db;

  // Target (NewHRMS via app models)
  await connectDB();

  await SystemSettings.findOneAndUpdate(
    { key: 'global' },
    { $setOnInsert: { key: 'global', overtime_multiplier: 1.5, deduction_multiplier: 1.0 } },
    { upsert: true }
  );

  const rawUsers = await hrms.collection('users').find({}).toArray();
  console.log(`hrms.users total: ${rawUsers.length}`);

  const selected = pickUniqueUsers(rawUsers);
  console.log(`Users selected after dedupe/skip-tests: ${selected.length}`);

  const deptNames = selected.map((u) => u.department);
  const deptMap = await ensureDepartments(deptNames);

  const existingEmps = await Employee.find({}).select('+password');
  const byName = new Map();
  const byEmail = new Map();
  for (const e of existingEmps) {
    byName.set(normalizeNameKey(e.name), e);
    byEmail.set(String(e.email).toLowerCase(), e);
  }

  // Special: map legacy lowercase "admin" → Admin employee with admin@krira.ai
  const adminEmp = byEmail.get('admin@krira.ai') || byName.get('admin');

  let codeSeq = await nextEmployeeCode();
  const usedEmails = new Set([...byEmail.keys()]);
  const legacyToEmp = new Map(); // hrms userId → Employee doc
  const mapRows = [];
  let created = 0;
  let updated = 0;

  for (const u of selected) {
    const nameKey = normalizeNameKey(u.name);
    const role = normalizeRole(u.role);
    const deptName = normalizeDept(u.department);
    const dept = deptMap.get(deptName);

    let emp =
      (nameKey === 'admin' && adminEmp) ||
      byName.get(nameKey) ||
      null;

    // Unique email for NewHRMS
    let email;
    if (emp) email = emp.email;
    else if (blank(u.email).toLowerCase() === 'admin@krira.ai') email = 'admin@krira.ai';
    else {
      let base = `${slugName(u.name)}@krira.ai`;
      email = base;
      let i = 2;
      while (usedEmails.has(email.toLowerCase())) {
        email = `${slugName(u.name)}${i}@krira.ai`;
        i += 1;
      }
    }
    usedEmails.add(email.toLowerCase());

    const bonds = mapBonds(u.bonds);
    const salary_schedule = mapSalarySchedule(u.salaryBreakdown);
    const base_salary = currentBaseSalary(u.salaryBreakdown) || Number(u.package) || 0;
    const primaryBond = bonds.find((b) => b.status === 'Active') || bonds[bonds.length - 1];

    const payload = {
      name: blank(u.name) === 'admin' ? 'Admin' : blank(u.name),
      email,
      phone: blank(u.phone || u.mobileNumber),
      department_id: dept?._id || null,
      role,
      joining_date: parseLegacyDate(u.joiningDate),
      status: u.isActive === false ? 'inactive' : 'active',
      base_salary,
      bank_details: {
        bank_name: blank(u.bankName),
        account_number: blank(u.bankAccountNumber),
        ifsc_code: blank(u.bankIfscCode),
        account_holder_name: blank(u.bankAccountHolderName),
        tax_id: '',
      },
      bonds,
      bond_details: primaryBond
        ? {
            bond_start_date: primaryBond.start_date,
            bond_end_date: primaryBond.end_date,
            bond_amount: primaryBond.amount,
            bond_status: primaryBond.status,
          }
        : undefined,
      salary_schedule,
      profile_details: {
        personal_email: '',
        emergency_contact: '',
        aadhaar_number: '',
      },
    };

    if (!emp) {
      codeSeq += 1;
      const employee_id = `EMP-2026-${String(codeSeq).padStart(4, '0')}`;
      if (DRY_RUN) {
        console.log(`[dry-run] create ${employee_id} ${payload.name} (${role})`);
        emp = { _id: new mongoose.Types.ObjectId(), employee_id, ...payload };
      } else {
        emp = await Employee.create({
          ...payload,
          employee_id,
          password: DEFAULT_PASSWORD,
        });
      }
      created += 1;
      byName.set(nameKey, emp);
      byEmail.set(email.toLowerCase(), emp);
    } else {
      if (!DRY_RUN) {
        Object.assign(emp, payload);
        // Do not touch password
        await emp.save();
      } else {
        console.log(`[dry-run] update ${emp.employee_id} ${payload.name} (${role})`);
      }
      updated += 1;
    }

    legacyToEmp.set(String(u._id), emp);
    mapRows.push({
      legacy_user_id: String(u._id),
      employee_id: emp.employee_id || emp.id,
      new_mongo_id: String(emp._id),
      name: emp.name || payload.name,
      email: emp.email || email,
      role,
      department: deptName,
      status: payload.status,
    });
  }

  console.log(`Employees created: ${created}, updated: ${updated}, mapped: ${legacyToEmp.size}`);

  // Also map any remaining hrms users (duplicates) that share a selected name → same emp
  for (const u of rawUsers) {
    if (legacyToEmp.has(String(u._id))) continue;
    const emp = byName.get(normalizeNameKey(u.name));
    if (emp) legacyToEmp.set(String(u._id), emp);
  }

  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const mapPath = path.join(EXPORTS_DIR, 'hrms_to_newhrms_map.json');
  fs.writeFileSync(mapPath, JSON.stringify(mapRows, null, 2));
  console.log(`Wrote map: ${mapPath}`);

  // Refresh employees_seed_data.json legacy ids where names match
  const seedPath = path.join(EXPORTS_DIR, 'employees_seed_data.json');
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    for (const s of seed) {
      const match = mapRows.find(
        (m) => normalizeNameKey(m.name) === normalizeNameKey(s.name)
      );
      if (match) s.legacy_user_id = match.legacy_user_id;
    }
    fs.writeFileSync(seedPath, JSON.stringify(seed, null, 2));
    console.log('Updated employees_seed_data.json legacy_user_id values');
  }

  // ---- Attendance ----
  const attCursor = hrms.collection('attendances').find({ date: { $lte: CUTOFF } });
  const attRows = await attCursor.toArray();
  console.log(`Attendance rows <= ${CUTOFF}: ${attRows.length}`);

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
  const empIdsTouched = new Set();
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
    const emp = legacyToEmp.get(String(r.userId));
    if (!emp) {
      attSkipped += 1;
      bar.update(i + 1);
      continue;
    }
    const date = blank(r.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > CUTOFF) {
      attSkipped += 1;
      bar.update(i + 1);
      continue;
    }

    const check_in = toHHMM(r.checkIn);
    const check_out = toHHMM(r.checkOut);
    const break_total = breakMinutes(r.breaks);
    let working_hours =
      Math.round(((Number(r.totalWorkedSeconds) || 0) / 3600) * 10000) / 10000;

    const threshold = await thresholdFor(emp._id);
    let status;
    let surplus_shortfall;
    if (check_in && !check_out) {
      status = 'Working';
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
            break_started_at: null,
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
    empIdsTouched.add(String(emp._id));

    if (ops.length >= 100) await flushAtt();
    if ((i + 1) % 50 === 0 || i + 1 === attRows.length) bar.update(i + 1);
  }
  await flushAtt();
  bar.stop();
  console.log(`Attendance upserted: ${attUpserted}, skipped (no emp/bad date): ${attSkipped}`);

  // ---- Leaves ----
  const leaveRows = await hrms
    .collection('leaverequests')
    .find({ startDate: { $lte: CUTOFF } })
    .toArray();
  console.log(`Leave rows startDate<=${CUTOFF}: ${leaveRows.length}`);

  const touchedEmpObjectIds = [...empIdsTouched]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  // Also include employees mapped even without attendance
  for (const emp of legacyToEmp.values()) {
    const id = String(emp._id);
    if (!empIdsTouched.has(id) && mongoose.isValidObjectId(id)) {
      touchedEmpObjectIds.push(emp._id);
    }
  }

  if (!DRY_RUN && touchedEmpObjectIds.length) {
    const del = await Leave.deleteMany({
      employee_id: { $in: touchedEmpObjectIds },
      from_date: { $lte: CUTOFF },
    });
    console.log(`Cleared existing leaves (<=${CUTOFF}): ${del.deletedCount}`);
  }

  let leavesInserted = 0;
  let leavesSkipped = 0;
  const leaveDocs = [];

  for (const lv of leaveRows) {
    const emp = legacyToEmp.get(String(lv.userId));
    if (!emp) {
      // try by userName
      const byN = byName.get(normalizeNameKey(lv.userName));
      if (!byN) {
        leavesSkipped += 1;
        continue;
      }
      legacyToEmp.set(String(lv.userId), byN);
    }
    const employee = legacyToEmp.get(String(lv.userId));
    if (!shouldImportLeave(lv.category)) {
      leavesSkipped += 1;
      continue;
    }
    const from_date = blank(lv.startDate).slice(0, 10);
    const to_date = blank(lv.endDate || lv.startDate).slice(0, 10);
    if (!from_date || from_date > CUTOFF) {
      leavesSkipped += 1;
      continue;
    }
    const cat = blank(lv.category);
    const reasonBase = blank(lv.reason);
    const reason =
      cat.toLowerCase().includes('extra time')
        ? `[Extra Time Leave] ${reasonBase}`.trim()
        : cat.toLowerCase().includes('unpaid')
          ? `[Unpaid] ${reasonBase}`.trim()
          : cat.toLowerCase().includes('paid') && !cat.toLowerCase().includes('unpaid')
            ? `[Paid] ${reasonBase}`.trim()
            : reasonBase;

    leaveDocs.push({
      employee_id: employee._id,
      from_date,
      to_date: to_date > CUTOFF ? CUTOFF : to_date,
      day_type: mapLeaveDayType(cat),
      reason,
      status: mapLeaveStatus(lv.status),
      applied_on: lv.createdAt ? new Date(lv.createdAt) : new Date(),
      approved_by: null,
      approved_on:
        mapLeaveStatus(lv.status) === 'Approved'
          ? lv.updatedAt
            ? new Date(lv.updatedAt)
            : new Date()
          : null,
    });

    const [y, m] = from_date.split('-').map(Number);
    monthKeys.add(`${employee._id}|${m}|${y}`);
  }

  if (!DRY_RUN && leaveDocs.length) {
    // insert in chunks
    for (let i = 0; i < leaveDocs.length; i += 200) {
      const chunk = leaveDocs.slice(i, i + 200);
      await Leave.insertMany(chunk, { ordered: false });
      leavesInserted += chunk.length;
    }
  } else {
    leavesInserted = leaveDocs.length;
  }
  console.log(`Leaves inserted: ${leavesInserted}, skipped: ${leavesSkipped}`);

  // ---- Management OT (Approved only) ----
  const mgmtRows = await hrms
    .collection('attendances')
    .find({
      date: { $lte: CUTOFF },
      'managementOvertime.durationMinutes': { $gt: 0 },
      'managementOvertime.status': 'Approved',
    })
    .toArray();

  if (!DRY_RUN && touchedEmpObjectIds.length) {
    const delOt = await OvertimeRequest.deleteMany({
      employee_id: { $in: touchedEmpObjectIds },
      date: { $lte: CUTOFF },
      ot_type: 'Management',
      reason: { $regex: /^\[Migrated management OT\]/ },
    });
    console.log(`Cleared prior migrated management OT: ${delOt.deletedCount}`);
  }

  let otInserted = 0;
  for (const r of mgmtRows) {
    const emp = legacyToEmp.get(String(r.userId));
    if (!emp) continue;
    const mins = Number(r.managementOvertime?.durationMinutes) || 0;
    if (mins < 1) continue;
    const hours = Math.round((mins / 60) * 10000) / 10000;
    if (hours < 0.01) continue;
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
  console.log(`Management OT requests: ${otInserted}`);

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

  // ---- Verify ----
  const empCount = await Employee.countDocuments();
  const attCount = await Attendance.countDocuments({ date: { $lte: CUTOFF } });
  const leaveCount = await Leave.countDocuments({ from_date: { $lte: CUTOFF } });
  const otCount = await OvertimeRequest.countDocuments({ date: { $lte: CUTOFF } });
  const roles = await Employee.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }]);

  console.log('\n=== Migration complete ===');
  console.log(`NewHRMS employees:     ${empCount}`, roles);
  console.log(`Attendance <=${CUTOFF}: ${attCount}`);
  console.log(`Leaves <=${CUTOFF}:     ${leaveCount}`);
  console.log(`OT requests <=${CUTOFF}: ${otCount}`);
  console.log(`Map file: ${mapPath}`);

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
