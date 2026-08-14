import { minutesBetween, timeToDecimal, timeToSeconds, earlierClock, effectiveWorkStart } from '../utils/helpers.js';
import { computeDailyStatus } from './shift.js';

/**
 * Recalculate day fields.
 * Auto-checkout at 11:55 PM keeps the checkout stamp, but payable work stops at shift end
 * so forgotten checkouts do not become General OT.
 *
 * @param record attendance-like object (check_in/out, break_total, break_started_at, penalty_waived, auto_checkout)
 * @param threshold daily working_hours_per_day
 * @param shiftStart department/employee shift start (HH:MM[:SS]) — used for late +15m work start
 * @param shiftEnd department/employee shift end (HH:MM[:SS]) — payable cap when auto_checkout
 */
export function recalculateAttendanceFields(record, threshold, shiftStart = null, shiftEnd = null) {
  let breakMinutes = Number(record.break_total || 0);
  const workStart = effectiveWorkStart(record.check_in, shiftStart, !!record.penalty_waived);

  if (record.check_in && record.check_out) {
    let workEnd = record.check_out;
    if (record.auto_checkout && shiftEnd && timeToSeconds(record.check_out) > timeToSeconds(shiftEnd)) {
      workEnd = earlierClock(record.check_out, shiftEnd);
      if (workStart && timeToSeconds(workStart) > timeToSeconds(workEnd)) {
        workEnd = workStart;
      }
    }
    const totalMin = Math.max(0, minutesBetween(workStart, workEnd));
    const workMin = Math.max(0, totalMin - breakMinutes);
    const working_hours = workMin / 60;
    const { status, surplus_shortfall } = computeDailyStatus(working_hours, threshold);
    return { working_hours, status, surplus_shortfall, break_total: breakMinutes };
  }
  if (record.check_in && !record.check_out) {
    if (record.break_started_at) {
      return { working_hours: 0, status: 'OnBreak', surplus_shortfall: 0, break_total: breakMinutes };
    }
    return { working_hours: 0, status: 'Working', surplus_shortfall: 0, break_total: breakMinutes };
  }
  return { working_hours: 0, status: 'Absent', surplus_shortfall: 0, break_total: breakMinutes };
}

export { timeToDecimal, effectiveWorkStart };
