import Leave from '../models/Leave.js';
import { datesInRange } from '../utils/helpers.js';

/**
 * Approved leave day-fraction by YYYY-MM-DD (Half Day = 0.5, Full Day = 1).
 * Overlapping leaves take the larger fraction.
 */
export async function approvedLeaveFractionByDate(employeeId, fromDate, toDate) {
  const leaves = await Leave.find({
    employee_id: employeeId,
    status: 'Approved',
    from_date: { $lte: toDate },
    to_date: { $gte: fromDate },
  }).lean();

  const map = new Map();
  for (const lv of leaves) {
    const fraction = lv.day_type === 'Half Day' ? 0.5 : 1;
    for (const d of datesInRange(lv.from_date, lv.to_date)) {
      if (d >= fromDate && d <= toDate) {
        map.set(d, Math.max(map.get(d) || 0, fraction));
      }
    }
  }
  return map;
}

export async function approvedLeaveFractionOnDate(employeeId, date) {
  const map = await approvedLeaveFractionByDate(employeeId, date, date);
  return map.get(date) || 0;
}

/** Expected checkout hours vs OT threshold for a leave fraction. */
export function dutyHoursFromShift(shift, leaveFraction) {
  const full = Number(shift?.working_hours_per_day ?? 8.25);
  const halfRaw = shift?.half_day_hours;
  const half = Number(halfRaw != null && Number.isFinite(Number(halfRaw)) ? halfRaw : full / 2);
  if (Number(leaveFraction) >= 0.5 && Number(leaveFraction) < 1) {
    return { expectedHours: half, otHours: full, isHalfDay: true };
  }
  return { expectedHours: full, otHours: full, isHalfDay: false };
}
