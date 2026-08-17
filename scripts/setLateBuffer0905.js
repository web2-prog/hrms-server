/**
 * Set late buffer so all departments allow check-in through 09:05 (inclusive),
 * then recalculate existing attendance working hours + monthly summaries.
 *
 * Rule: shift 08:45 + 20m → through 09:05:59 OK; 09:06 applies +15m penalty.
 *
 * Usage: node scripts/setLateBuffer0905.js
 */
import dns from 'dns';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cliProgress from 'cli-progress';

import { connectDB } from '../config/db.js';
import Department from '../models/Department.js';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import {
  DEFAULT_LATE_BUFFER_UNTIL,
  lateBufferMinutesFromUntil,
  lateBufferUntil,
  lateCheckInPenalty,
} from '../utils/helpers.js';
import { getEffectiveShiftForEmployee } from '../services/shift.js';
import { recalculateAttendanceFields } from '../services/attendanceCalc.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';

dotenv.config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', ...dns.getServers()]);
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

async function main() {
  await connectDB();

  const depts = await Department.find({});
  console.log(`Updating ${depts.length} departments → late until ${DEFAULT_LATE_BUFFER_UNTIL}`);

  for (const d of depts) {
    const shift = d.shift_start || '08:45';
    const mins = lateBufferMinutesFromUntil(shift, DEFAULT_LATE_BUFFER_UNTIL);
    const prev = d.late_buffer_minutes;
    d.late_buffer_minutes = mins;
    await d.save();
    console.log(
      `  ${d.name}: shift ${shift} → buffer ${mins}m (until ${lateBufferUntil(shift, mins)})` +
        (prev !== mins ? ` [was ${prev ?? 'unset'}]` : '')
    );
  }

  const employees = await Employee.find({ status: { $ne: 'inactive' } }).select('_id name employee_id');
  console.log(`\nRecalculating attendance for ${employees.length} employees…`);

  const monthKeys = new Set();
  let updated = 0;
  let unchanged = 0;
  let lateNow = 0;
  let waivedLate = 0;
  const samples = [];

  const bar = new cliProgress.SingleBar(
    {
      format: 'Attendance |{bar}| {percentage}% | {value}/{total}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(employees.length, 0);

  for (let i = 0; i < employees.length; i += 1) {
    const emp = employees[i];
    const shift = await getEffectiveShiftForEmployee(emp._id);
    if (!shift) {
      bar.update(i + 1);
      continue;
    }

    const rows = await Attendance.find({
      employee_id: emp._id,
      check_in: { $ne: null },
    });

    for (const rec of rows) {
      const before = {
        working_hours: rec.working_hours,
        status: rec.status,
        surplus_shortfall: rec.surplus_shortfall,
      };
      const penalty = lateCheckInPenalty(
        rec.check_in,
        shift.shift_start,
        !!rec.penalty_waived,
        shift.late_buffer_minutes
      );
      if (penalty.late) {
        lateNow += 1;
        if (rec.penalty_waived) waivedLate += 1;
      }

      if (rec.check_out) {
        const fields = recalculateAttendanceFields(
          rec,
          shift.working_hours_per_day,
          shift.shift_start,
          shift.late_buffer_minutes
        );
        const changed =
          Number(before.working_hours || 0) !== Number(fields.working_hours || 0) ||
          before.status !== fields.status ||
          Number(before.surplus_shortfall || 0) !== Number(fields.surplus_shortfall || 0);
        if (changed) {
          Object.assign(rec, fields);
          await rec.save();
          updated += 1;
          if (samples.length < 12) {
            samples.push({
              employee: emp.name,
              date: rec.date,
              check_in: rec.check_in,
              late: penalty.late,
              penalty_minutes: penalty.penalty_minutes,
              before_hours: before.working_hours,
              after_hours: fields.working_hours,
              buffer_until: lateBufferUntil(shift.shift_start, shift.late_buffer_minutes),
            });
          }
        } else {
          unchanged += 1;
        }
      }

      const [y, m] = String(rec.date).split('-').map(Number);
      if (y && m) monthKeys.add(`${emp._id}|${m}|${y}`);
    }

    bar.update(i + 1);
  }
  bar.stop();

  const monthList = [...monthKeys].map((k) => {
    const [empId, m, y] = k.split('|');
    return { empId, month: Number(m), year: Number(y) };
  });
  console.log(`\nRecalculating ${monthList.length} monthly summaries…`);

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

  console.log('\n=== Late buffer backfill complete ===');
  console.log({
    departments: depts.length,
    attendance_rows_updated: updated,
    attendance_rows_unchanged: unchanged,
    late_checkins_under_new_rule: lateNow,
    late_but_waived: waivedLate,
    monthly_summaries: monthList.length,
  });
  if (samples.length) {
    console.log('Sample recalcs:', JSON.stringify(samples, null, 2));
  }

  // Quick sanity: 09:05 OK, 09:06 late for 08:45 / 20m
  const ok905 = lateCheckInPenalty('09:05:00', '08:45', false, 20);
  const late906 = lateCheckInPenalty('09:06:00', '08:45', false, 20);
  console.log('Sanity 09:05 →', ok905);
  console.log('Sanity 09:06 →', late906);
  if (ok905.late || !late906.late || late906.penalty_minutes !== 15) {
    throw new Error('Buffer rule sanity check failed');
  }

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
