/**
 * Replace NewHRMS leave records with the official sheet
 * (backend/exports/Employee_Leave_Data_sheet.txt), including Praduman Jul 23.
 *
 * Crossed-out sheet rows were omitted from the file.
 * Paid/Unpaid is stored in `reason` (Leave schema has no pay field).
 *
 * Usage: node scripts/setLeavesFromSheet.js [path-to-txt]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import { connectDB } from '../config/db.js';
import Employee from '../models/Employee.js';
import Leave from '../models/Leave.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(__dirname, '..', 'exports', 'Employee_Leave_Data_sheet.txt');

const NAME_ALIASES = {
  'Arshit Badani': 'Arshit Bhadani',
  'Arshit Badani ': 'Arshit Bhadani',
  'Raj rajodiya': 'Raj Rajodiya',
  'Khayati Bhut': 'Khyati Bhut',
  'khanak Prajapati': 'Khanakh Prajapati',
  'Khanak Prajapati': 'Khanakh Prajapati',
  'Narednra Mali': 'Narendra Mali',
  'kaushik vaghashiya': 'Kaushik Vaghasiya',
  'Keval soanki': 'Keval Solanki',
  'Pradyuman kumar': 'Praduman Kumar',
  'Pradyuman Kumar': 'Praduman Kumar',
  'prduman': 'Praduman Kumar',
  'Yash gondaliya': 'Yash Gondaliya',
  'Rupesh garasodiya': 'Rupesh Garasodiya',
  'Aditya shrivastav': 'Aditya Shrivastav',
  'Prashant thakur': 'Prashant Thakur',
  'maulik ghoghari': 'Maulik Ghoghari',
};

const MONTHS = {
  Jan: 1,
  January: 1,
  Feb: 2,
  February: 2,
  Mar: 3,
  March: 3,
  Apr: 4,
  April: 4,
  May: 5,
  Jun: 6,
  June: 6,
  Jul: 7,
  July: 7,
  Aug: 8,
  August: 8,
  Sep: 9,
  September: 9,
  Oct: 10,
  October: 10,
  Nov: 11,
  November: 11,
  Dec: 12,
  December: 12,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toISO(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function monthNum(token) {
  const m = MONTHS[token] || MONTHS[token.slice(0, 3)];
  if (!m) throw new Error(`Unknown month "${token}"`);
  return m;
}

/**
 * Supports:
 *  - Jan 16, 2026
 *  - May 6-8, 2026
 *  - July 7-21, 2026
 *  - Apr 30-May 2, 2026  (cross-month)
 *  - april 31 to may 2, 2026 (normalized by caller)
 */
function parseDateToken(raw) {
  let s = raw.trim().replace(/[–—]/g, '-').replace(/\s+to\s+/gi, '-');
  s = s.replace(/\s+/g, ' ');

  // Cross-month: Apr 30-May 2, 2026
  let m = s.match(
    /^([A-Za-z]+)\s+(\d{1,2})\s*-\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/i
  );
  if (m) {
    const y = Number(m[5]);
    return {
      from_date: toISO(y, monthNum(m[1]), Number(m[2])),
      to_date: toISO(y, monthNum(m[3]), Number(m[4])),
    };
  }

  // Same-month range: May 6-8, 2026 / July 7-21, 2026
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2}),\s*(\d{4})$/i);
  if (m) {
    const y = Number(m[4]);
    const mo = monthNum(m[1]);
    return {
      from_date: toISO(y, mo, Number(m[2])),
      to_date: toISO(y, mo, Number(m[3])),
    };
  }

  // Single: Jan 16, 2026 / July 06, 2026
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/i);
  if (m) {
    const iso = toISO(Number(m[3]), monthNum(m[1]), Number(m[2]));
    return { from_date: iso, to_date: iso };
  }

  throw new Error(`Unrecognized date: "${raw}"`);
}

function parseSheet(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];
  for (const line of lines) {
    if (/^Name\t/i.test(line) || /^Name\s+Date/i.test(line)) continue;

    // TSV preferred
    let parts = line.split('\t').map((p) => p.trim());
    if (parts.length < 4) {
      // fallback: "Name | date | Full Day Leave | Paid Leave"
      const m = line.match(
        /^(.+?)\s+(\S.*\d{4})\s+(Full|Half)\s+Day\s+Leave\s+(Paid|Unpaid)\s+Leave$/i
      );
      if (!m) {
        console.warn('Skip unparseable line:', line);
        continue;
      }
      parts = [m[1].trim(), m[2].trim(), `${m[3]} Day Leave`, `${m[4]} Leave`];
    }

    const [nameRaw, dateRaw, dayRaw, payRaw] = parts;
    const { from_date, to_date } = parseDateToken(dateRaw);
    const day_type = /half/i.test(dayRaw) ? 'Half Day' : 'Full Day';
    const pay = /unpaid/i.test(payRaw) ? 'Unpaid' : 'Paid';
    rows.push({
      name: nameRaw.replace(/\s+/g, ' ').trim(),
      from_date,
      to_date,
      day_type,
      reason: `${day_type} ${pay} Leave`,
      pay,
    });
  }
  return rows;
}

function resolveName(name) {
  return NAME_ALIASES[name] || name;
}

async function main() {
  const filePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE;
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const rows = parseSheet(fs.readFileSync(filePath, 'utf8'));
  console.log(`Parsed ${rows.length} leave row(s) from ${filePath}`);

  await connectDB();

  const employees = await Employee.find({}).select('_id name employee_id role').lean();
  const byLower = new Map(employees.map((e) => [e.name.toLowerCase(), e]));
  const admin = employees.find((e) => e.role === 'admin') || null;

  const missing = [];
  const resolved = [];
  for (const row of rows) {
    const resolvedName = resolveName(row.name);
    const emp =
      byLower.get(resolvedName.toLowerCase()) ||
      byLower.get(row.name.toLowerCase()) ||
      [...byLower.values()].find(
        (e) =>
          e.name.toLowerCase().includes(resolvedName.toLowerCase().split(' ')[0]) &&
          e.name.toLowerCase().includes(resolvedName.toLowerCase().split(' ').slice(-1)[0])
      );
    if (!emp) {
      missing.push(row.name);
      continue;
    }
    resolved.push({ ...row, emp });
  }

  if (missing.length) {
    console.error('Employees not found:', [...new Set(missing)].join(', '));
    process.exit(1);
  }

  // Source of truth: wipe all leaves, then insert sheet rows
  const del = await Leave.deleteMany({});
  console.log(`Cleared existing leaves: ${del.deletedCount}`);

  const monthKeys = new Set();
  const bar = new cliProgress.SingleBar(
    {
      format: 'Insert leaves |{bar}| {percentage}% | {value}/{total} | {status}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(resolved.length, 0, { status: 'starting' });

  for (let i = 0; i < resolved.length; i += 1) {
    const row = resolved[i];
    await Leave.create({
      employee_id: row.emp._id,
      from_date: row.from_date,
      to_date: row.to_date,
      day_type: row.day_type,
      reason: row.reason,
      status: 'Approved',
      applied_on: new Date(`${row.from_date}T00:00:00.000Z`),
      approved_by: admin?._id || null,
      approved_on: new Date(),
    });

    const start = new Date(`${row.from_date}T00:00:00`);
    const end = new Date(`${row.to_date}T00:00:00`);
    const cur = new Date(start);
    while (cur <= end) {
      monthKeys.add(`${row.emp._id}|${cur.getMonth() + 1}|${cur.getFullYear()}`);
      cur.setMonth(cur.getMonth() + 1);
      cur.setDate(1);
    }
    monthKeys.add(`${row.emp._id}|${start.getMonth() + 1}|${start.getFullYear()}`);

    bar.update(i + 1, { status: `${row.emp.name} ${row.from_date}` });
  }
  bar.stop();

  const recalcList = [...monthKeys];
  const sumBar = new cliProgress.SingleBar(
    {
      format: 'Monthly summary |{bar}| {percentage}% | {value}/{total}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
    },
    cliProgress.Presets.shades_classic
  );
  sumBar.start(recalcList.length, 0);
  for (let i = 0; i < recalcList.length; i += 1) {
    const [empId, m, y] = recalcList[i].split('|');
    await recalculateMonthlySummary(empId, Number(m), Number(y));
    sumBar.update(i + 1);
  }
  sumBar.stop();

  const byEmp = new Map();
  for (const row of resolved) {
    const key = row.emp.name;
    if (!byEmp.has(key)) byEmp.set(key, []);
    byEmp
      .get(key)
      .push(
        `${row.from_date}${row.from_date !== row.to_date ? `→${row.to_date}` : ''} (${row.reason})`
      );
  }

  console.log('\nLeaves by employee:');
  for (const [name, items] of [...byEmp.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${name}: ${items.length}`);
    for (const item of items) console.log(`    - ${item}`);
  }

  const praduman = resolved.filter((r) => /praduman/i.test(r.emp.name));
  console.log(
    `\nPraduman check: ${praduman.map((r) => `${r.from_date} ${r.reason}`).join('; ') || 'MISSING'}`
  );

  const total = await Leave.countDocuments();
  console.log(`\nDone. inserted=${resolved.length}, DB leaves=${total}, summaries=${recalcList.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
