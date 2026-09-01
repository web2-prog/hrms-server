import { minutesBetween, timeToDecimal, effectiveWorkStart } from '../utils/helpers.js';
import { computeDailyStatus } from './shift.js';

/**
 * Recalculate day fields.
 * @param record attendance-like object (check_in/out, break_total, break_started_at, penalty_waived)
 * @param threshold daily working_hours_per_day
 * @param shiftStart department/employee shift start (HH:MM[:SS])
 * @param lateBufferMinutes inclusive department grace period after shift start
 */
export function recalculateAttendanceFields(
  record,
  threshold,
  shiftStart = null,
  lateBufferMinutes = undefined,
  duty = null
) {
  let breakMinutes = Number(record.break_total || 0);
  const workStart = effectiveWorkStart(
    record.check_in,
    shiftStart,
    !!record.penalty_waived,
    lateBufferMinutes,
    record.penalty_minutes_override
  );
  const expectedHours = duty?.expectedHours ?? threshold;
  const otHours = duty?.otHours ?? threshold;

  if (record.check_in && record.check_out) {
    const totalMin = Math.max(0, minutesBetween(workStart, record.check_out));
    const workMin = Math.max(0, totalMin - breakMinutes);
    const working_hours = workMin / 60;
    const { status, surplus_shortfall } = computeDailyStatus(working_hours, expectedHours, otHours);
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
