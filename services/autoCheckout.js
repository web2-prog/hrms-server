import Attendance from '../models/Attendance.js';
import EarlyCheckoutRequest from '../models/EarlyCheckoutRequest.js';
import CoverTimeRequest from '../models/CoverTimeRequest.js';
import { todayISO, nowTime, minutesBetween, timeToSeconds } from '../utils/helpers.js';
import { getEffectiveShiftForEmployee } from './shift.js';
import { approvedLeaveFractionOnDate, dutyHoursFromShift } from './leaveDuty.js';
import { recalculateAttendanceFields } from './attendanceCalc.js';
import { recalculateForDate } from './monthlyHours.js';

/** If still checked in at this time, the day is closed automatically. */
export const AUTO_CHECKOUT_TIME = '23:55:00';
const AUTO_CHECKOUT_SECONDS = timeToSeconds(AUTO_CHECKOUT_TIME);

let schedulerTimer = null;

export function isAtOrAfterAutoCheckout(time = nowTime()) {
  return timeToSeconds(time) >= AUTO_CHECKOUT_SECONDS;
}

function checkoutTimeForRecord(rec) {
  if (timeToSeconds(rec.check_in) >= AUTO_CHECKOUT_SECONDS) return rec.check_in;
  return AUTO_CHECKOUT_TIME;
}

function isDueForAutoCheckout(rec, today, now) {
  if (!rec?.check_in || rec.check_out) return false;
  if (rec.date < today) return true;
  if (rec.date === today && isAtOrAfterAutoCheckout(now)) return true;
  return false;
}

async function applyAutoCheckout(rec) {
  const checkoutTime = checkoutTimeForRecord(rec);
  if (rec.break_started_at) {
    const mins = minutesBetween(rec.break_started_at, checkoutTime);
    rec.break_total = Number(((rec.break_total || 0) + Math.max(0, mins)).toFixed(4));
    rec.break_started_at = null;
  }
  rec.check_out = checkoutTime;
  rec.auto_checkout = true;
  const shift = await getEffectiveShiftForEmployee(rec.employee_id);
  const duty = dutyHoursFromShift(
    shift,
    await approvedLeaveFractionOnDate(rec.employee_id, rec.date)
  );
  Object.assign(
    rec,
    recalculateAttendanceFields(
      rec,
      shift?.working_hours_per_day ?? 8.25,
      shift?.shift_start,
      shift?.late_buffer_minutes,
      duty
    )
  );
  await rec.save();
  await recalculateForDate(rec.employee_id, rec.date);
  await EarlyCheckoutRequest.updateMany(
    { employee_id: rec.employee_id, date: rec.date, status: 'Pending' },
    {
      $set: {
        status: 'Cancelled',
        decision_note: 'Auto-checked out at 11:55 PM',
        decided_at: new Date(),
      },
    }
  );

  // Capture cover hours from auto-checkout day (HR can still approve/reject).
  const activeCover = await CoverTimeRequest.findOne({
    employee_id: rec.employee_id,
    date: rec.date,
    status: { $in: ['Pending', 'Approved'] },
  }).sort({ createdAt: -1 });
  if (activeCover) {
    const threshold = Number(shift?.working_hours_per_day ?? 8.25);
    const excess = Math.max(0, Number(rec.working_hours || 0) - threshold);
    const actual = Math.round(Math.min(Number(activeCover.requested_hours) || 0, excess) * 10000) / 10000;
    activeCover.actual_cover_hours = actual;
    await activeCover.save();
    await recalculateForDate(rec.employee_id, rec.date);
  }

  return rec;
}

/**
 * Close open check-ins that missed 11:55 PM (previous days, or today after cutoff).
 * @param {{ employeeId?: unknown, date?: string }} [opts]
 */
export async function closeStaleOpenSessions(opts = {}) {
  const today = todayISO();
  const now = nowTime();
  const filter = {
    check_in: { $nin: [null, ''] },
    $or: [{ check_out: null }, { check_out: '' }],
  };
  if (opts.employeeId) filter.employee_id = opts.employeeId;
  if (opts.date) filter.date = opts.date;

  const open = await Attendance.find(filter);
  let checkedOut = 0;
  for (const rec of open) {
    if (!isDueForAutoCheckout(rec, today, now)) continue;
    await applyAutoCheckout(rec);
    checkedOut += 1;
  }
  return { checkedOut, scanned: open.length };
}

function msUntilNextAutoCheckout() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(23, 55, 0, 0);
  if (now.getTime() >= next.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function runScheduledAutoCheckout() {
  try {
    const result = await closeStaleOpenSessions();
    console.log(`Auto-checkout: closed ${result.checkedOut} open session(s)`);
  } catch (e) {
    console.error('Auto-checkout failed', e);
  }
}

/** Daily 11:55 PM job + catch-up for sessions missed while the server was down. */
export function startAutoCheckoutScheduler() {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  runScheduledAutoCheckout();
  const scheduleNext = () => {
    const ms = msUntilNextAutoCheckout();
    console.log(`Auto-checkout scheduled in ${Math.round(ms / 1000)}s (11:55 PM)`);
    schedulerTimer = setTimeout(async () => {
      await runScheduledAutoCheckout();
      scheduleNext();
    }, ms);
    schedulerTimer.unref?.();
  };
  scheduleNext();
}
