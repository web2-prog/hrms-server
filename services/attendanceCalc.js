import { minutesBetween, timeToDecimal } from '../utils/helpers.js';
import { computeDailyStatus } from './shift.js';

export function recalculateAttendanceFields(record, threshold) {
  let breakMinutes = Number(record.break_total || 0);
  if (record.check_in && record.check_out) {
    const totalMin = minutesBetween(record.check_in, record.check_out);
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

export { timeToDecimal };
