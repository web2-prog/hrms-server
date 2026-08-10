/**
 * Import leave records from Employee_Leave_Data.txt and create Approved leaves
 * for matching employees. Recalculates monthly summaries afterward.
 *
 * Usage: node scripts/seedLeavesFromFile.js [path-to-txt]
 * Default path: C:\Users\Sahil\Downloads\Employee_Leave_Data.txt
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import { connectDB } from '../config/db.js';
import Employee from '../models/Employee.js';
import Leave from '../models/Leave.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';

dotenv.config();

const DEFAULT_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  'Downloads',
  'Employee_Leave_Data.txt'
);

/** Source-file name → DB employee name (typos / spelling) */
const NAME_ALIASES = {
  'Arshit Badani': 'Arshit Bhadani',
};

const MONTHS = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toISO(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Parse "Jan 16, 2026" or "May 6–8, 2026" / "May 6-8, 2026"
 * → { from_date, to_date }
 */
function parseDateToken(raw) {
  const s = raw.trim().replace(/[–—]/g, '-');
  // Range: May 6-8, 2026
  let m = s.match(/^([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1]];
    if (!month) throw new Error(`Unknown month in "${raw}"`);
    const year = Number(m[4]);
    const fromDay = Number(m[2]);
    const toDay = Number(m[3]);
    return { from_date: toISO(year, month, fromDay), to_date: toISO(year, month, toDay) };
  }
  // Single: Jan 16, 2026
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1]];
    if (!month) throw new Error(`Unknown month in "${raw}"`);
    const year = Number(m[3]);
    const day = Number(m[2]);
    const iso = toISO(year, month, day);
    return { from_date: iso, to_date: iso };
  }
  throw new Error(`Unrecognized date: "${raw}"`);
}

/**
 * Flatten wrapped lines and extract leave rows.
 * Pattern: Name + Date + (Full|Half) Day Leave + (Paid|Unpaid) Leave
 */
function parseLeaveFile(text) {
  const flat = text
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const body = flat
    .replace(/^Name Date Full\/Half Day Paid\/Unpaid\s*/i, '')
    .trim();

  const re =
    /([A-Za-z][A-Za-z.'\-\s]+?)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:\s*[–—-]\s*\d{1,2})?,\s*\d{4})\s+(Full|Half)\s+Day\s+Leave\s+(Paid|Unpaid)\s+Leave/gi;

  const rows = [];
  let match;
  while ((match = re.exec(body)) !== null) {
    const name = match[1].trim().replace(/\s+/g, ' ');
    const { from_date, to_date } = parseDateToken(match[2]);
    const dayType = match[3]; // Full | Half
    const payType = match[4]; // Paid | Unpaid
    rows.push({
      name,
      from_date,
      to_date,
      day_type: `${dayType} Day`,
      pay_type: `${payType} Leave`,
      reason: `${dayType} Day ${payType} Leave`,
    });
  }
  return rows;
}

async function resolveEmployeeMap(names) {
  const employees = await Employee.find({}).select('_id name employee_id role').lean();
  const byLower = new Map(employees.map((e) => [e.name.toLowerCase(), e]));

  const map = new Map();
  const missing = [];
  for (const name of names) {
    const resolved = NAME_ALIASES[name] || name;
    const emp = byLower.get(resolved.toLowerCase()) || byLower.get(name.toLowerCase());
    if (!emp) {
      missing.push(name);
      continue;
    }
    map.set(name, emp);
  }
  return { map, missing, admin: employees.find((e) => e.role === 'admin') || null };
}

async function main() {
  const filePath = process.argv[2] || DEFAULT_FILE;
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseLeaveFile(text);
  if (!rows.length) {
    console.error('No leave rows parsed from file.');
    process.exit(1);
  }

  console.log(`Parsed ${rows.length} leave row(s) from ${filePath}`);

  await connectDB();

  const uniqueNames = [...new Set(rows.map((r) => r.name))];
  const { map, missing, admin } = await resolveEmployeeMap(uniqueNames);
  if (missing.length) {
    console.error('Employees not found:', missing.join(', '));
    process.exit(1);
  }

  const bar = new cliProgress.SingleBar({
    format: 'Applying leaves |{bar}| {percentage}% | {value}/{total} | {status}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
  });
  bar.start(rows.length, 0, { status: 'starting' });

  let created = 0;
  let skipped = 0;
  const monthKeys = new Set(); // empId|month|year

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const emp = map.get(row.name);
    bar.update(i, { status: `${emp.name} ${row.from_date}` });

    const existing = await Leave.findOne({
      employee_id: emp._id,
      from_date: row.from_date,
      to_date: row.to_date,
      status: 'Approved',
    }).lean();

    if (existing) {
      skipped += 1;
      bar.update(i + 1, { status: `skip ${emp.name}` });
      continue;
    }

    await Leave.create({
      employee_id: emp._id,
      from_date: row.from_date,
      to_date: row.to_date,
      day_type: row.day_type === 'Half Day' ? 'Half Day' : 'Full Day',
      reason: row.reason,
      status: 'Approved',
      applied_on: new Date(`${row.from_date}T00:00:00.000Z`),
      approved_by: admin?._id || null,
      approved_on: new Date(),
    });
    created += 1;

    // Track months to recalculate (cover range)
    const start = new Date(`${row.from_date}T00:00:00`);
    const end = new Date(`${row.to_date}T00:00:00`);
    const cur = new Date(start);
    while (cur <= end) {
      const y = cur.getFullYear();
      const m = cur.getMonth() + 1;
      monthKeys.add(`${emp._id}|${m}|${y}`);
      cur.setMonth(cur.getMonth() + 1);
      cur.setDate(1);
    }
    // Always include start month
    monthKeys.add(`${emp._id}|${start.getMonth() + 1}|${start.getFullYear()}`);

    bar.update(i + 1, { status: `ok ${emp.name}` });
  }

  bar.update(rows.length, { status: 'recalc summaries' });
  bar.stop();

  const recalcList = [...monthKeys];
  if (recalcList.length) {
    const recalcBar = new cliProgress.SingleBar({
      format: 'Monthly summary |{bar}| {percentage}% | {value}/{total}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
    });
    recalcBar.start(recalcList.length, 0);
    for (let i = 0; i < recalcList.length; i++) {
      const [empId, m, y] = recalcList[i].split('|');
      await recalculateMonthlySummary(empId, Number(m), Number(y));
      recalcBar.update(i + 1);
    }
    recalcBar.stop();
  }

  // Summary by employee
  const byEmp = new Map();
  for (const row of rows) {
    const emp = map.get(row.name);
    const key = emp.name;
    if (!byEmp.has(key)) byEmp.set(key, []);
    byEmp.get(key).push(`${row.from_date}${row.from_date !== row.to_date ? `→${row.to_date}` : ''} (${row.reason})`);
  }

  console.log('\nLeaves by employee:');
  for (const [name, items] of byEmp) {
    console.log(`  ${name}: ${items.length}`);
    for (const item of items) console.log(`    - ${item}`);
  }

  console.log(`\nDone. created=${created}, skipped_duplicates=${skipped}, parsed=${rows.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
