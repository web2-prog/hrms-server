/**
 * Sync overtime_requests in NewHRMS from hrms.attendances (general + management OT).
 *
 * Replaces ALL overtime_requests for mapped employees in the date range, removing
 * duplicates/test rows and aligning with legacy HRMS.
 *
 * Usage:
 *   node scripts/syncHrmsOvertime.js
 *   node scripts/syncHrmsOvertime.js --from 2026-05-01 --to 2026-08-31
 *   node scripts/syncHrmsOvertime.js --dry-run
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
import OvertimeRequest from '../models/OvertimeRequest.js';
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

const FROM = argValue('--from', '2026-05-01');
const TO = argValue('--to', todayIstYmd());

function blank(v) {
  return String(v ?? '').trim();
}

function mapOtStatus(s) {
  const v = blank(s).toLowerCase();
  if (v === 'approved') return 'Approved';
  if (v === 'rejected') return 'Rejected';
  if (v === 'pending') return 'Pending';
  return null;
}

function minutesToHours(mins) {
  const m = Number(mins) || 0;
  if (m <= 0) return 0;
  return Math.round((m / 60) * 10000) / 10000;
}

export function extractGeneralOtFromAttendance(r) {
  const ot = r.overtimeRequest;
  if (!ot || typeof ot !== 'object') return null;
  const mins = Number(ot.durationMinutes) || 0;
  if (mins <= 0) return null;
  const status = mapOtStatus(ot.status);
  if (!status) return null;
  const hours = minutesToHours(mins);
  if (hours <= 0) return null;
  return {
    hours,
    status,
    reason: blank(ot.reason) || 'General OT',
    applied_on: ot.requestedAt ? new Date(ot.requestedAt) : new Date(),
    decided_on:
      status === 'Pending'
        ? null
        : ot.approvedAt
          ? new Date(ot.approvedAt)
          : new Date(),
    ot_type: status === 'Approved' ? 'General' : undefined,
  };
}

export function extractManagementOtFromAttendance(r) {
  const mgmt = r.managementOvertime;
  if (!mgmt || typeof mgmt !== 'object') return null;
  const mins = Number(mgmt.durationMinutes) || 0;
  if (mins <= 0) return null;
  const status = mapOtStatus(mgmt.status);
  if (status !== 'Approved') return null;
  const hours = minutesToHours(mins);
  if (hours <= 0) return null;
  return {
    hours,
    status: 'Approved',
    reason: blank(mgmt.reason) || 'Management OT',
    applied_on: mgmt.requestedAt ? new Date(mgmt.requestedAt) : new Date(),
    decided_on: mgmt.approvedAt ? new Date(mgmt.approvedAt) : new Date(),
    ot_type: 'Management',
  };
}

async function main() {
  console.log(`Sync HRMS overtime → NewHRMS ${FROM}..${TO}${DRY_RUN ? ' (DRY RUN)' : ''}`);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
    throw new Error(`Invalid date range: ${FROM} .. ${TO}`);
  }
  if (FROM > TO) throw new Error(`FROM (${FROM}) > TO (${TO})`);

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI required');
  if (!fs.existsSync(MAP_PATH)) {
    throw new Error(`Employee map missing: ${MAP_PATH}`);
  }

  const mapRows = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  const legacyToEmpId = new Map(
    mapRows
      .filter((r) => mongoose.isValidObjectId(r.new_mongo_id))
      .map((r) => [r.legacy_user_id, r.new_mongo_id])
  );
  const empIds = [...new Set([...legacyToEmpId.values()])].map(
    (id) => new mongoose.Types.ObjectId(id)
  );

  const hrmsConn = await mongoose.createConnection(uri, { dbName: 'hrms' }).asPromise();
  const hrms = hrmsConn.db;
  await connectDB();

  const employees = await Employee.find({ _id: { $in: empIds } }).select('_id name employee_id').lean();
  const empNameById = new Map(employees.map((e) => [String(e._id), e.name]));

  const attRows = await hrms
    .collection('attendances')
    .find({ date: { $gte: FROM, $lte: TO } })
    .sort({ date: 1, userId: 1 })
    .toArray();
  console.log(`HRMS attendance rows in range: ${attRows.length}`);

  const docs = [];
  const monthKeys = new Set();
  const touchedEmpIds = new Set();
  let generalCount = 0;
  let mgmtCount = 0;
  let skippedUnmapped = 0;

  for (const r of attRows) {
    const empId = legacyToEmpId.get(String(r.userId));
    if (!empId) {
      skippedUnmapped += 1;
      continue;
    }
    const date = blank(r.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    touchedEmpIds.add(empId);
    const [y, m] = date.split('-').map(Number);
    monthKeys.add(`${empId}|${m}|${y}`);

    const general = extractGeneralOtFromAttendance(r);
    if (general) {
      docs.push({
        employee_id: new mongoose.Types.ObjectId(empId),
        date,
        hours: general.hours,
        reason: `[Migrated general OT] ${general.reason}`,
        status: general.status,
        ot_type: general.ot_type,
        applied_on: general.applied_on,
        decided_on: general.decided_on,
        decision_note: `Imported from hrms.attendances.overtimeRequest (${FROM}..${TO})`,
      });
      generalCount += 1;
    }

    const mgmt = extractManagementOtFromAttendance(r);
    if (mgmt) {
      docs.push({
        employee_id: new mongoose.Types.ObjectId(empId),
        date,
        hours: mgmt.hours,
        reason: `[Migrated management OT] ${mgmt.reason}`,
        status: mgmt.status,
        ot_type: mgmt.ot_type,
        applied_on: mgmt.applied_on,
        decided_on: mgmt.decided_on,
        decision_note: `Imported from hrms.attendances.managementOvertime (${FROM}..${TO})`,
      });
      mgmtCount += 1;
    }
  }

  console.log(`Source OT rows: general=${generalCount}, management=${mgmtCount}, unmapped att=${skippedUnmapped}`);

  const touchedObjectIds = [...touchedEmpIds].map((id) => new mongoose.Types.ObjectId(id));
  let deleted = 0;
  if (!DRY_RUN && touchedObjectIds.length) {
    const del = await OvertimeRequest.deleteMany({
      employee_id: { $in: touchedObjectIds },
      date: { $gte: FROM, $lte: TO },
    });
    deleted = del.deletedCount;
    console.log(`Removed existing overtime_requests in range: ${deleted}`);
  } else if (DRY_RUN) {
    deleted = await OvertimeRequest.countDocuments({
      employee_id: { $in: touchedObjectIds },
      date: { $gte: FROM, $lte: TO },
    });
    console.log(`Would remove existing overtime_requests in range: ${deleted}`);
  }

  let inserted = 0;
  if (!DRY_RUN && docs.length) {
    for (let i = 0; i < docs.length; i += 200) {
      const chunk = docs.slice(i, i + 200);
      await OvertimeRequest.insertMany(chunk, { ordered: false });
      inserted += chunk.length;
    }
  } else {
    inserted = docs.length;
  }
  console.log(`${DRY_RUN ? 'Would insert' : 'Inserted'} overtime_requests: ${inserted}`);

  const monthList = [...monthKeys].map((k) => {
    const [empId, month, year] = k.split('|');
    return { empId, month: Number(month), year: Number(year) };
  });

  if (!DRY_RUN && monthList.length) {
    console.log(`Recalculating monthly summaries: ${monthList.length}`);
    const bar = new cliProgress.SingleBar(
      {
        format: 'Summaries |{bar}| {percentage}% | {value}/{total}',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );
    bar.start(monthList.length, 0);
    for (let i = 0; i < monthList.length; i += 1) {
      const { empId, month, year } = monthList[i];
      try {
        await recalculateMonthlySummary(empId, month, year);
      } catch (e) {
        console.warn(`\nSummary failed ${empId} ${month}/${year}:`, e.message);
      }
      bar.update(i + 1);
    }
    bar.stop();
  }

  // Verify Rutika example if in range
  const rutikaId = legacyToEmpId.get('695f91c0dcb30e2572d6b8b3');
  if (rutikaId && '2026-08-19' >= FROM && '2026-08-19' <= TO) {
    const rutikaOt = await OvertimeRequest.find({
      employee_id: rutikaId,
      date: '2026-08-19',
    }).lean();
    console.log(
      `Rutika 2026-08-19 OT (${rutikaOt.length}):`,
      rutikaOt.map((o) => ({
        hours: o.hours,
        reason: o.reason,
        status: o.status,
        ot_type: o.ot_type,
      }))
    );
  }

  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const stamp = todayIstYmd();
  const reportPath = path.join(EXPORTS_DIR, `hrms_overtime_sync_${FROM}_to_${TO}_${stamp}.md`);
  const lines = [
    `# HRMS overtime sync`,
    '',
    `- **Range:** ${FROM} → ${TO}`,
    `- **Mode:** ${DRY_RUN ? 'dry-run' : 'applied'}`,
    `- **Deleted (range):** ${deleted}`,
    `- **Inserted:** ${inserted} (general ${generalCount}, management ${mgmtCount})`,
    `- **Employees touched:** ${touchedEmpIds.size}`,
    `- **Summaries recalculated:** ${monthList.length}`,
    '',
  ];
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`Report: ${reportPath}`);

  await hrmsConn.close();
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
