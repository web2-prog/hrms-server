/**
 * Export ALL attendance check-in / check-out / break totals from DB `hrms`.
 * Joins users for employee name. Progress bar in terminal.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cliProgress from 'cli-progress';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'exports');
const stamp = new Date().toISOString().slice(0, 10);
const CSV_FILE = path.join(OUT_DIR, `all_employees_attendance_${stamp}.csv`);

function pad(n) {
  return String(Math.floor(Math.abs(n))).padStart(2, '0');
}

function secondsToHM(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return '';
  const s = Math.max(0, Math.round(Number(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(r)}`;
}

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  // India local wall-clock from stored Date
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

function fmtDate(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function csvEscape(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function breakTotalSeconds(breaks) {
  if (!Array.isArray(breaks) || !breaks.length) return 0;
  return breaks.reduce((sum, b) => {
    if (b?.durationSeconds != null) return sum + Number(b.durationSeconds) || 0;
    if (b?.start && b?.end) {
      const ms = new Date(b.end) - new Date(b.start);
      return sum + (ms > 0 ? ms / 1000 : 0);
    }
    return sum;
  }, 0);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.client.db('hrms');

  console.log('Loading users from hrms.users…');
  const users = await db.collection('users').find({}).project({ password: 0 }).toArray();
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  console.log(`Users loaded: ${users.length}`);

  const total = await db.collection('attendances').countDocuments();
  console.log(`Attendance records: ${total} (from earliest to latest, none skipped)`);

  const bar = new cliProgress.SingleBar(
    {
      format: 'Attendance Export |{bar}| {percentage}% | {value}/{total} | {status}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(total, 0, { status: 'writing' });

  const headers = [
    'SNo',
    'EmployeeName',
    'Email',
    'Username',
    'Department',
    'Role',
    'Date',
    'CheckIn',
    'CheckOut',
    'BreakCount',
    'TotalBreakTime',
    'TotalBreakSeconds',
    'TotalWorkedTime',
    'TotalWorkedSeconds',
    'Location',
    'UserId',
    'AttendanceId',
  ];

  const out = fs.createWriteStream(CSV_FILE, { encoding: 'utf8' });
  out.write('\uFEFF'); // BOM for Excel
  out.write(headers.join(',') + '\n');

  let sno = 0;
  let processed = 0;
  const cursor = db.collection('attendances').find({}).sort({ date: 1, checkIn: 1 });

  for await (const a of cursor) {
    sno += 1;
    processed += 1;
    const u = userMap.get(String(a.userId)) || {};
    const breakSec = breakTotalSeconds(a.breaks);
    const row = [
      sno,
      u.name || '',
      u.email || '',
      u.username || '',
      u.department || '',
      u.role || '',
      fmtDate(a.date),
      fmtTime(a.checkIn),
      fmtTime(a.checkOut),
      Array.isArray(a.breaks) ? a.breaks.length : 0,
      secondsToHM(breakSec),
      Math.round(breakSec),
      secondsToHM(a.totalWorkedSeconds),
      a.totalWorkedSeconds != null ? Math.round(Number(a.totalWorkedSeconds)) : '',
      a.location || '',
      String(a.userId || ''),
      String(a._id || ''),
    ].map(csvEscape);

    out.write(row.join(',') + '\n');

    if (processed % 50 === 0 || processed === total) {
      bar.update(processed, { status: fmtDate(a.date) || '…' });
    }
  }

  bar.update(total, { status: 'done' });
  bar.stop();

  await new Promise((resolve, reject) => {
    out.end(() => resolve());
    out.on('error', reject);
  });

  // Summary by employee
  const summaryFile = path.join(OUT_DIR, `all_employees_attendance_summary_${stamp}.csv`);
  const agg = await db
    .collection('attendances')
    .aggregate([
      {
        $group: {
          _id: '$userId',
          days: { $sum: 1 },
          firstDate: { $min: '$date' },
          lastDate: { $max: '$date' },
          totalBreakSeconds: {
            $sum: {
              $reduce: {
                input: { $ifNull: ['$breaks', []] },
                initialValue: 0,
                in: {
                  $add: [
                    '$$value',
                    { $ifNull: ['$$this.durationSeconds', 0] },
                  ],
                },
              },
            },
          },
          totalWorkedSeconds: { $sum: { $ifNull: ['$totalWorkedSeconds', 0] } },
        },
      },
    ])
    .toArray();

  const sumBar = new cliProgress.SingleBar(
    {
      format: 'Summary Export |{bar}| {percentage}% | {value}/{total}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  sumBar.start(agg.length, 0);

  const sumLines = [
    ['EmployeeName', 'Email', 'Department', 'Role', 'AttendanceDays', 'FirstDate', 'LastDate', 'TotalBreakTime', 'TotalWorkedTime', 'UserId']
      .join(','),
  ];
  agg
    .map((r) => {
      const u = userMap.get(String(r._id)) || {};
      return {
        name: u.name || '',
        email: u.email || '',
        department: u.department || '',
        role: u.role || '',
        days: r.days,
        firstDate: r.firstDate,
        lastDate: r.lastDate,
        breakSec: r.totalBreakSeconds || 0,
        workSec: r.totalWorkedSeconds || 0,
        userId: String(r._id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((r, i) => {
      sumLines.push(
        [r.name, r.email, r.department, r.role, r.days, r.firstDate, r.lastDate, secondsToHM(r.breakSec), secondsToHM(r.workSec), r.userId]
          .map(csvEscape)
          .join(',')
      );
      sumBar.update(i + 1);
    });
  sumBar.stop();
  fs.writeFileSync(summaryFile, '\uFEFF' + sumLines.join('\n'), 'utf8');

  await mongoose.disconnect();

  console.log(`\nDatabase: hrms`);
  console.log(`Records exported: ${processed} / ${total}`);
  console.log(`Employees with attendance: ${agg.length}`);
  console.log(`Detail CSV: ${CSV_FILE}`);
  console.log(`Summary CSV: ${summaryFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
