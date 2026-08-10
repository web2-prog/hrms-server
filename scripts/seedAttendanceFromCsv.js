/**
 * Import attendance from backend/exports/all_employees_attendance_*.csv
 * into NewHRMS. Maps legacy UserId → employee via employees_seed_data.json.
 *
 * Usage: node scripts/seedAttendanceFromCsv.js [path-to-csv]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import { connectDB } from '../config/db.js';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import { getEffectiveShiftForEmployee, computeDailyStatus } from '../services/shift.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_DIR = path.join(__dirname, '..', 'exports');

function findDefaultCsv() {
  const files = fs
    .readdirSync(EXPORTS_DIR)
    .filter((f) => /^all_employees_attendance_\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .sort()
    .reverse();
  if (!files.length) throw new Error('No attendance CSV found in exports/');
  return path.join(EXPORTS_DIR, files[0]);
}

/** Minimal CSV parser that respects quoted fields. */
function parseCsv(text) {
  const rows = [];
  let i = 0;
  const s = text.replace(/^\uFEFF/, '');
  while (i < s.length) {
    const row = [];
    while (i < s.length) {
      let cell = '';
      if (s[i] === '"') {
        i += 1;
        while (i < s.length) {
          if (s[i] === '"' && s[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          if (s[i] === '"') {
            i += 1;
            break;
          }
          cell += s[i];
          i += 1;
        }
      } else {
        while (i < s.length && s[i] !== ',' && s[i] !== '\n' && s[i] !== '\r') {
          cell += s[i];
          i += 1;
        }
      }
      row.push(cell);
      if (s[i] === ',') {
        i += 1;
        continue;
      }
      if (s[i] === '\r') i += 1;
      if (s[i] === '\n') i += 1;
      break;
    }
    if (row.length === 1 && row[0] === '' && i >= s.length) break;
    rows.push(row);
  }
  return rows;
}

function toHHMM(t) {
  const s = (t || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

async function buildLegacyMap() {
  const seedPath = path.join(EXPORTS_DIR, 'employees_seed_data.json');
  if (!fs.existsSync(seedPath)) {
    throw new Error(`Missing ${seedPath} — run seed:employees first`);
  }
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const employees = await Employee.find({}).select('_id name email employee_id').lean();
  const byEmail = new Map(employees.map((e) => [e.email.toLowerCase(), e]));
  const byName = new Map();
  for (const e of employees) {
    const key = e.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(e);
  }

  const legacyToEmp = new Map();
  const unmatchedSeed = [];

  for (const s of seed) {
    const legacy = String(s.legacy_user_id || '').trim();
    if (!legacy) continue;
    let emp = byEmail.get(String(s.email || '').toLowerCase());
    if (!emp) {
      const list = byName.get(String(s.name || '').trim().toLowerCase()) || [];
      emp = list.length === 1 ? list[0] : null;
    }
    if (!emp) {
      unmatchedSeed.push({ name: s.name, email: s.email, legacy });
      continue;
    }
    legacyToEmp.set(legacy, emp);
  }

  return { legacyToEmp, unmatchedSeed, employees };
}

async function main() {
  const csvPath = process.argv[2] ? path.resolve(process.argv[2]) : findDefaultCsv();
  console.log(`CSV: ${csvPath}`);

  const raw = fs.readFileSync(csvPath, 'utf8');
  const table = parseCsv(raw);
  if (table.length < 2) throw new Error('CSV has no data rows');

  const headers = table[0].map((h) => h.trim());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const required = ['Date', 'CheckIn', 'CheckOut', 'TotalBreakSeconds', 'TotalWorkedSeconds', 'UserId'];
  for (const h of required) {
    if (idx[h] == null) throw new Error(`CSV missing column: ${h}`);
  }

  const dataRows = table.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
  console.log(`CSV data rows: ${dataRows.length}`);

  await connectDB();
  const { legacyToEmp, unmatchedSeed } = await buildLegacyMap();
  console.log(`Legacy UserId → employee mappings: ${legacyToEmp.size}`);
  if (unmatchedSeed.length) {
    console.warn('Seed entries without DB employee:', unmatchedSeed);
  }

  // Cache effective shift thresholds
  const thresholdCache = new Map();
  async function thresholdFor(empId) {
    const key = String(empId);
    if (thresholdCache.has(key)) return thresholdCache.get(key);
    const shift = await getEffectiveShiftForEmployee(empId);
    const t = shift?.working_hours_per_day ?? 8.25;
    thresholdCache.set(key, t);
    return t;
  }

  const bar = new cliProgress.SingleBar(
    {
      format: 'Import attendance |{bar}| {percentage}% | {value}/{total} | {status}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(dataRows.length, 0, { status: 'starting' });

  let upserted = 0;
  let skippedNoUser = 0;
  let skippedBadDate = 0;
  let errors = 0;
  const skippedUserIds = new Map(); // userId → count
  const monthKeys = new Set(); // `${empId}|${m}|${y}`
  const perEmployee = new Map(); // empId → count

  const BATCH = 100;
  const ops = [];

  async function flush() {
    if (!ops.length) return;
    const batch = ops.splice(0, ops.length);
    try {
      await Attendance.bulkWrite(batch, { ordered: false });
      upserted += batch.length;
    } catch (e) {
      // Fallback one-by-one so one bad row does not lose the batch
      for (const op of batch) {
        try {
          await Attendance.bulkWrite([op], { ordered: false });
          upserted += 1;
        } catch (err) {
          errors += 1;
          console.error('\nUpsert error:', err.message, op.updateOne?.filter);
        }
      }
    }
  }

  for (let n = 0; n < dataRows.length; n += 1) {
    const r = dataRows[n];
    const userId = String(r[idx.UserId] || '').trim();
    const date = String(r[idx.Date] || '').trim().slice(0, 10);
    const emp = legacyToEmp.get(userId);

    if (!emp) {
      skippedNoUser += 1;
      skippedUserIds.set(userId, (skippedUserIds.get(userId) || 0) + 1);
      if ((n + 1) % 50 === 0 || n + 1 === dataRows.length) {
        bar.update(n + 1, { status: date || 'skip' });
      }
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skippedBadDate += 1;
      bar.update(n + 1, { status: 'bad-date' });
      continue;
    }

    const checkIn = toHHMM(r[idx.CheckIn]);
    const checkOut = toHHMM(r[idx.CheckOut]);
    const breakSec = Number(r[idx.TotalBreakSeconds] || 0) || 0;
    const workSec = Number(r[idx.TotalWorkedSeconds] || 0) || 0;
    const break_total = Math.round(breakSec / 60);
    let working_hours = Math.round((workSec / 3600) * 10000) / 10000;

    const threshold = await thresholdFor(emp._id);
    let status;
    let surplus_shortfall;

    if (checkIn && !checkOut) {
      status = 'Working';
      surplus_shortfall = 0;
      working_hours = 0;
    } else if (!checkIn) {
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
            check_in: checkIn,
            check_out: checkOut,
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

    const [y, m] = date.split('-').map(Number);
    monthKeys.add(`${emp._id}|${m}|${y}`);
    perEmployee.set(String(emp._id), (perEmployee.get(String(emp._id)) || 0) + 1);

    if (ops.length >= BATCH) await flush();

    if ((n + 1) % 25 === 0 || n + 1 === dataRows.length) {
      bar.update(n + 1, { status: `${date} ${emp.name.slice(0, 18)}` });
    }
  }

  await flush();
  bar.update(dataRows.length, { status: 'done' });
  bar.stop();

  // Monthly summaries
  const monthList = [...monthKeys].map((k) => {
    const [empId, m, y] = k.split('|');
    return { empId, month: Number(m), year: Number(y) };
  });

  const sumBar = new cliProgress.SingleBar(
    {
      format: 'Monthly summaries |{bar}| {percentage}% | {value}/{total}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  sumBar.start(monthList.length, 0);
  let summaries = 0;
  for (let i = 0; i < monthList.length; i += 1) {
    const { empId, month, year } = monthList[i];
    await recalculateMonthlySummary(empId, month, year);
    summaries += 1;
    sumBar.update(i + 1);
  }
  sumBar.stop();

  const totalAtt = await Attendance.countDocuments();
  const withCheckIn = await Attendance.countDocuments({ check_in: { $ne: null } });

  console.log('\n--- Import complete ---');
  console.log(`CSV rows:              ${dataRows.length}`);
  console.log(`Upserted:              ${upserted}`);
  console.log(`Skipped (no employee): ${skippedNoUser}`);
  console.log(`Skipped (bad date):    ${skippedBadDate}`);
  console.log(`Upsert errors:         ${errors}`);
  console.log(`Employees touched:     ${perEmployee.size}`);
  console.log(`Monthly summaries:     ${summaries}`);
  console.log(`DB attendances total:  ${totalAtt} (with check-in: ${withCheckIn})`);

  if (skippedUserIds.size) {
    console.log('\nSkipped legacy UserIds (no matching NewHRMS employee):');
    for (const [uid, count] of [...skippedUserIds.entries()].sort((a, b) => b[1] - a[1])) {
      const sample = dataRows.find((r) => String(r[idx.UserId]).trim() === uid);
      const name = sample ? String(sample[idx.EmployeeName] || '').trim() || '(blank name)' : '?';
      console.log(`  ${count}×  ${name}  UserId=${uid || '(empty)'}`);
    }
  }

  // Cross-check vs summary CSV if present
  const stamp = path.basename(csvPath).match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  if (stamp) {
    const sumPath = path.join(EXPORTS_DIR, `all_employees_attendance_summary_${stamp}.csv`);
    if (fs.existsSync(sumPath)) {
      const sumTable = parseCsv(fs.readFileSync(sumPath, 'utf8'));
      const sIdx = Object.fromEntries(sumTable[0].map((h, i) => [h.trim(), i]));
      let expected = 0;
      let matchedExpected = 0;
      for (const row of sumTable.slice(1)) {
        const uid = String(row[sIdx.UserId] || '').trim();
        const days = Number(row[sIdx.AttendanceDays] || 0) || 0;
        expected += days;
        if (legacyToEmp.has(uid)) matchedExpected += days;
      }
      console.log(`\nSummary CSV expected days (all):     ${expected}`);
      console.log(`Summary CSV expected (mappable):    ${matchedExpected}`);
      console.log(`Imported upserts:                   ${upserted}`);
      if (upserted !== matchedExpected) {
        console.warn('⚠ Count mismatch vs mappable summary — inspect skipped/duplicates.');
      } else {
        console.log('✓ Imported count matches mappable summary days.');
      }
    }
  }

  process.exit(errors ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
