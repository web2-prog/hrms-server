/**
 * Verify hrms ↔ NewHRMS fidelity for a date range.
 * Usage: node scripts/verifyRecentSync.js [--from 2026-08-09] [--to 2026-08-12]
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
const MAP_PATH = path.join(__dirname, '..', 'exports', 'hrms_to_newhrms_map.json');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const FROM = argValue('--from', '2026-08-09');
const TO = argValue('--to', '2026-08-12');

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
  return `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}:${parts.find((p) => p.type === 'second')?.value}`;
}

function breakSeconds(breaks) {
  if (!Array.isArray(breaks)) return 0;
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

function clockKey(t) {
  if (!t) return null;
  return String(t).length === 5 ? `${t}:00` : String(t);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI required');
  const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  const legacyToNew = new Map(map.map((r) => [r.legacy_user_id, r]));

  const hrmsConn = await mongoose.createConnection(uri, { dbName: 'hrms' }).asPromise();
  const newConn = await mongoose.createConnection(uri, { dbName: 'NewHRMS' }).asPromise();
  const hrms = hrmsConn.db;
  const nh = newConn.db;

  const srcAtt = await hrms
    .collection('attendances')
    .find({ date: { $gte: FROM, $lte: TO } })
    .toArray();
  const dstAtt = await nh
    .collection('attendances')
    .find({ date: { $gte: FROM, $lte: TO } })
    .toArray();
  const dstByKey = new Map(dstAtt.map((a) => [`${a.employee_id}|${a.date}`, a]));

  let missing = 0;
  let timeMismatch = 0;
  let secondsLost = 0;
  let breakMismatch = 0;
  let statusIssues = 0;
  let openBreaksSrc = 0;
  let openBreaksDst = 0;
  const samples = [];

  for (const r of srcAtt) {
    const mapRow = legacyToNew.get(String(r.userId));
    if (!mapRow) {
      missing += 1;
      continue;
    }
    const d = dstByKey.get(`${mapRow.new_mongo_id}|${r.date}`);
    if (!d) {
      missing += 1;
      if (samples.length < 15) samples.push({ type: 'missing', name: mapRow.name, date: r.date });
      continue;
    }

    const inSrc = toHHMMSS(r.checkIn);
    const outSrc = toHHMMSS(r.checkOut);
    const open = (r.breaks || []).find((b) => b?.start && !b?.end);
    if (open) openBreaksSrc += 1;
    if (d.break_started_at) openBreaksDst += 1;

    if (inSrc && d.check_in) {
      if (clockKey(d.check_in) !== inSrc) {
        if (String(d.check_in).length === 5 && inSrc.startsWith(d.check_in)) secondsLost += 1;
        else {
          timeMismatch += 1;
          if (samples.length < 15) {
            samples.push({ type: 'check_in', name: mapRow.name, date: r.date, src: inSrc, dst: d.check_in });
          }
        }
      }
    }
    if ((outSrc || null) && d.check_out) {
      if (clockKey(d.check_out) !== outSrc) {
        if (String(d.check_out).length === 5 && outSrc.startsWith(d.check_out)) secondsLost += 1;
        else {
          timeMismatch += 1;
          if (samples.length < 15) {
            samples.push({ type: 'check_out', name: mapRow.name, date: r.date, src: outSrc, dst: d.check_out });
          }
        }
      }
    } else if (!!outSrc !== !!d.check_out) {
      timeMismatch += 1;
      if (samples.length < 15) {
        samples.push({ type: 'check_out_null', name: mapRow.name, date: r.date, src: outSrc, dst: d.check_out });
      }
    }

    const brMin = Math.round((breakSeconds(r.breaks) / 60) * 10000) / 10000;
    const dstBr = Number(d.break_total || 0);
    if (Math.abs(brMin - dstBr) > 0.02 && !(open && Math.abs(Math.round(brMin) - Math.round(dstBr)) <= 1)) {
      // allow rounding to whole minutes for now, flag only large gaps
      if (Math.abs(Math.round(brMin) - Math.round(dstBr)) > 0) {
        breakMismatch += 1;
        if (samples.length < 15) {
          samples.push({ type: 'break', name: mapRow.name, date: r.date, src: brMin, dst: dstBr, open: !!open });
        }
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
          break_started_at: d.break_started_at,
        });
      }
    } else if (d.check_in && !d.check_out && !open && !d.break_started_at && d.status !== 'Working') {
      statusIssues += 1;
    }
  }

  const leavesSrc = await hrms.collection('leaverequests').find({}).toArray();
  const leaveOverlap = leavesSrc.filter((lv) => {
    const f = String(lv.startDate || '').slice(0, 10);
    const t = String(lv.endDate || lv.startDate || '').slice(0, 10);
    return f && f <= TO && t >= FROM;
  });
  const leavesDst = await nh.collection('leaves').find({ from_date: { $lte: TO }, to_date: { $gte: FROM } }).toArray();

  // Unit-check attendanceCalc expectations
  const { recalculateAttendanceFields } = await import('../services/attendanceCalc.js');
  const calcCases = [
    {
      name: 'on-break',
      input: { check_in: '09:00:00', check_out: null, break_total: 5, break_started_at: '10:00:00' },
      expect: 'OnBreak',
    },
    {
      name: 'working',
      input: { check_in: '09:00:00', check_out: null, break_total: 5, break_started_at: null },
      expect: 'Working',
    },
    {
      name: 'absent',
      input: { check_in: null, check_out: null, break_total: 0, break_started_at: null },
      expect: 'Absent',
    },
  ];
  const calcResults = calcCases.map((c) => {
    const out = recalculateAttendanceFields(c.input, 8.25);
    return { name: c.name, expect: c.expect, got: out.status, ok: out.status === c.expect };
  });

  const report = {
    range: { FROM, TO },
    srcAtt: srcAtt.length,
    dstAtt: dstAtt.length,
    missing,
    timeMismatch,
    secondsLost,
    breakMismatch,
    statusIssues,
    openBreaksSrc,
    openBreaksDst,
    leavesSrcOverlap: leaveOverlap.length,
    leavesDst: leavesDst.length,
    statusCounts: dstAtt.reduce((a, r) => {
      a[r.status] = (a[r.status] || 0) + 1;
      return a;
    }, {}),
    calcResults,
    samples,
    ok:
      missing === 0 &&
      timeMismatch === 0 &&
      statusIssues === 0 &&
      secondsLost === 0 &&
      calcResults.every((c) => c.ok),
  };

  console.log(JSON.stringify(report, null, 2));

  await hrmsConn.close();
  await newConn.close();
  process.exit(report.ok ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
