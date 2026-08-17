import EarlyCheckoutRequest from '../models/EarlyCheckoutRequest.js';
import Attendance from '../models/Attendance.js';
import { minutesBetween } from '../utils/helpers.js';

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Minutes left before shift end for an approved early-checkout request.
 * Requests at/after shift end are not early and contribute 0.
 */
export function earlyMinutesForRequest(requestedTime, shiftEnd) {
  if (!requestedTime || !shiftEnd) return 0;
  return Math.max(0, minutesBetween(requestedTime, shiftEnd));
}

/**
 * Load approved early-checkout requests in a date prefix scope (YYYY or YYYY-MM).
 */
export async function loadApprovedEarlyCheckouts({ employeeIds, datePrefix }) {
  const filter = {
    status: 'Approved',
    date: { $regex: `^${datePrefix}` },
  };
  if (employeeIds?.length) filter.employee_id = { $in: employeeIds };
  return EarlyCheckoutRequest.find(filter)
    .select('employee_id date requested_time attendance_id')
    .lean();
}

/**
 * Salary / month stats: only approved early-checkout requests count.
 */
export async function computeApprovedEarlyCheckoutStats(employeeId, month, year, shift) {
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const shiftEnd = shift?.shift_end || '17:30';
  const threshold = shift?.working_hours_per_day ?? 8.25;

  const requests = await EarlyCheckoutRequest.find({
    employee_id: employeeId,
    date: { $regex: `^${monthPrefix}` },
    status: 'Approved',
  })
    .select('date requested_time')
    .lean();

  if (!requests.length) return { minutes: 0, shortfall_hours: 0, count: 0 };

  const dates = requests.map((r) => r.date);
  const attendance = await Attendance.find({
    employee_id: employeeId,
    date: { $in: dates },
  })
    .select('date check_out working_hours')
    .lean();
  const attByDate = new Map(attendance.map((a) => [a.date, a]));

  let mins = 0;
  let shortfallHours = 0;
  let count = 0;
  for (const req of requests) {
    const leaveAt = req.requested_time || attByDate.get(req.date)?.check_out;
    const early = earlyMinutesForRequest(leaveAt, shiftEnd);
    if (early <= 0) continue;
    mins += early;
    count += 1;
    const actual = Number(attByDate.get(req.date)?.working_hours) || 0;
    if (actual < threshold) shortfallHours += threshold - actual;
  }

  return {
    minutes: round2(mins),
    shortfall_hours: round2(shortfallHours),
    count,
  };
}
