import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import MonthlySummary from '../models/MonthlySummary.js';
import OvertimeRequest from '../models/OvertimeRequest.js';
import CoverTimeRequest from '../models/CoverTimeRequest.js';
import { getWorkingDaysInMonth } from './workingDays.js';
import { getEffectiveShiftForEmployee } from './shift.js';
import { recalculateAttendanceFields } from './attendanceCalc.js';
import { datesInRange } from '../utils/helpers.js';

/** Month-end Salary Deduction / Carry Forward management starts 1 Aug 2026. */
export const SHORTFALL_MANAGEMENT_START = { year: 2026, month: 8 };

export function isShortfallManagementActive(month, year) {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isFinite(m) || !Number.isFinite(y)) return false;
  if (y > SHORTFALL_MANAGEMENT_START.year) return true;
  if (y < SHORTFALL_MANAGEMENT_START.year) return false;
  return m >= SHORTFALL_MANAGEMENT_START.month;
}

export function previousMonthYear(month, year) {
  if (month === 1) return { month: 12, year: year - 1 };
  return { month: month - 1, year };
}

export function nextMonthYear(month, year) {
  if (month === 12) return { month: 1, year: year + 1 };
  return { month: month + 1, year };
}

async function getCarriedForwardHours(employeeId, month, year) {
  // Carry-forward into this month only after shortfall management is active,
  // and only from a previous month that itself is in the management window.
  if (!isShortfallManagementActive(month, year)) return 0;

  const prev = previousMonthYear(month, year);
  if (!isShortfallManagementActive(prev.month, prev.year)) return 0;

  const prevSummary = await MonthlySummary.findOne({
    employee_id: employeeId,
    month: prev.month,
    year: prev.year,
  }).lean();

  if (!prevSummary || prevSummary.shortfall_action !== 'carry_forward') return 0;

  if (prevSummary.carried_to_next_hours != null && prevSummary.carried_to_next_hours > 0) {
    return Number(prevSummary.carried_to_next_hours);
  }
  return Math.max(0, (prevSummary.monthly_target_hours || 0) - (prevSummary.monthly_counted_hours || 0));
}

export async function recalculateMonthlySummary(employeeId, month, year) {
  const shift = await getEffectiveShiftForEmployee(employeeId);
  if (!shift) return null;
  const threshold = shift.working_hours_per_day;

  const { working_days, working_dates } = await getWorkingDaysInMonth(year, month);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

  const leaves = await Leave.find({
    employee_id: employeeId,
    status: 'Approved',
    from_date: { $lte: `${monthPrefix}-31` },
    to_date: { $gte: `${monthPrefix}-01` },
  }).lean();

  const leaveDayMap = new Map();
  for (const lv of leaves) {
    const fraction = lv.day_type === 'Half Day' ? 0.5 : 1;
    for (const d of datesInRange(lv.from_date, lv.to_date)) {
      if (d.startsWith(monthPrefix) && working_dates.includes(d)) {
        leaveDayMap.set(d, Math.max(leaveDayMap.get(d) || 0, fraction));
      }
    }
  }
  let approved_leave_days_in_month = 0;
  for (const frac of leaveDayMap.values()) approved_leave_days_in_month += frac;

  // Full-month target is identical for everyone on the same shift/calendar —
  // do not reduce for leave, early checkout, or other personal absences.
  // Leave days are still tracked separately (approved_leave_days_in_month).
  let base_monthly_target_hours = threshold * working_days;
  if (base_monthly_target_hours < 0) base_monthly_target_hours = 0;

  const carried_forward_hours = await getCarriedForwardHours(employeeId, month, year);
  const monthly_target_hours = base_monthly_target_hours + carried_forward_hours;

  const records = await Attendance.find({
    employee_id: employeeId,
    date: { $regex: `^${monthPrefix}` },
  }).lean();

  let monthly_counted_hours = 0;
  let attendance_ot_hours = 0;
  let low_hours_from_checkout = 0;
  for (const r of records) {
    // Recompute completed days with the current department policy. This keeps
    // manual checkouts, auto-checkouts, and the bulk-recalculate action aligned.
    if (r.check_in && r.check_out) {
      const fields = recalculateAttendanceFields(r, threshold, shift.shift_start, shift.late_buffer_minutes);
      const changed =
        Number(r.working_hours || 0) !== fields.working_hours ||
        Number(r.surplus_shortfall || 0) !== fields.surplus_shortfall ||
        r.status !== fields.status;
      if (changed) {
        await Attendance.updateOne({ _id: r._id }, { $set: fields });
        Object.assign(r, fields);
      }
    }
    if (!r.check_out && !r.working_hours) continue;
    const actual = r.working_hours || 0;
    const counted = Math.min(actual, threshold);
    monthly_counted_hours += counted;
    if (!r.auto_checkout && actual > threshold) attendance_ot_hours += actual - threshold;
    if (r.check_out && actual < threshold) low_hours_from_checkout += threshold - actual;
  }

  // monthly_counted_hours = attendance (+ cover time below) only — never leave hours.

  // Approved cover time counts toward monthly working hours (fills shortfall) and
  // is excluded from attendance OT for the same day.
  const coverRequests = await CoverTimeRequest.find({
    employee_id: employeeId,
    status: 'Approved',
    date: { $regex: `^${monthPrefix}` },
  }).lean();

  let cover_time_hours = 0;
  const coverByDate = new Map();
  for (const req of coverRequests) {
    const hrs = Math.max(0, Number(req.actual_cover_hours) || Number(req.requested_hours) || 0);
    if (hrs <= 0) continue;
    cover_time_hours += hrs;
    coverByDate.set(req.date, (coverByDate.get(req.date) || 0) + hrs);
  }
  monthly_counted_hours += cover_time_hours;

  if (coverByDate.size) {
    let adjustedOt = 0;
    for (const r of records) {
      if (r.auto_checkout) continue;
      const actual = r.working_hours || 0;
      if (actual <= threshold) continue;
      const cover = coverByDate.get(r.date) || 0;
      adjustedOt += Math.max(0, actual - threshold - cover);
    }
    attendance_ot_hours = adjustedOt;
  }

  const otRequests = await OvertimeRequest.find({
    employee_id: employeeId,
    status: 'Approved',
    date: { $regex: `^${monthPrefix}` },
  }).lean();

  let management_ot_hours = 0;
  for (const req of otRequests) {
    const hrs = Number(req.hours) || 0;
    if (req.ot_type === 'Management') management_ot_hours += hrs;
  }

  // General OT = automatic surplus from checkout only (attendance_ot_hours).
  const overtime_hours = attendance_ot_hours;
  const monthly_shortfall_or_surplus = monthly_counted_hours - monthly_target_hours;
  const pending_hours = Math.max(0, monthly_target_hours - monthly_counted_hours);

  const absence_low =
    monthly_shortfall_or_surplus < 0
      ? Math.max(0, Math.abs(monthly_shortfall_or_surplus) - low_hours_from_checkout)
      : 0;
  const low_hours = Math.round((low_hours_from_checkout + absence_low) * 10000) / 10000;

  const existing = await MonthlySummary.findOne({ employee_id: employeeId, month, year }).lean();
  const update = {
    base_monthly_target_hours: Math.round(base_monthly_target_hours * 10000) / 10000,
    carried_forward_hours: Math.round(carried_forward_hours * 10000) / 10000,
    monthly_target_hours: Math.round(monthly_target_hours * 10000) / 10000,
    monthly_counted_hours: Math.round(monthly_counted_hours * 10000) / 10000,
    monthly_shortfall_or_surplus: Math.round(monthly_shortfall_or_surplus * 10000) / 10000,
    pending_hours: Math.round(pending_hours * 10000) / 10000,
    working_days_in_month: working_days,
    approved_leave_days_in_month,
    attendance_ot_hours: Math.round(attendance_ot_hours * 10000) / 10000,
    overtime_hours: Math.round(overtime_hours * 10000) / 10000,
    management_ot_hours: Math.round(management_ot_hours * 10000) / 10000,
    cover_time_hours: Math.round(cover_time_hours * 10000) / 10000,
    low_hours,
  };

  // Keep carried_to_next in sync when already decided as carry_forward
  if (existing?.shortfall_action === 'carry_forward') {
    update.carried_to_next_hours = Math.round(pending_hours * 10000) / 10000;
  } else if (existing?.shortfall_action === 'deduct') {
    update.carried_to_next_hours = 0;
  }

  const doc = await MonthlySummary.findOneAndUpdate(
    { employee_id: employeeId, month, year },
    { $set: update },
    { upsert: true, new: true }
  );

  return doc;
}

export async function recalculateForDate(employeeId, dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return recalculateMonthlySummary(employeeId, m, y);
}

/**
 * Apply month-end shortfall decision and refresh next month target if needed.
 */
export async function applyShortfallDecision(employeeId, month, year, action, decidedBy) {
  if (!isShortfallManagementActive(month, year)) {
    throw new Error(
      'Salary Deduction / Carry Forward starts from August 2026. Earlier months are not managed this way.'
    );
  }

  const summary = await recalculateMonthlySummary(employeeId, month, year);
  if (!summary) throw new Error('Could not calculate monthly summary');

  const pending = Math.max(0, (summary.monthly_target_hours || 0) - (summary.monthly_counted_hours || 0));
  if (pending <= 0.01 && action === 'carry_forward') {
    throw new Error('No pending hours to carry forward');
  }
  if (pending <= 0.01 && action === 'deduct') {
    throw new Error('No pending hours to deduct');
  }

  summary.shortfall_action = action;
  summary.pending_hours = Math.round(pending * 10000) / 10000;
  summary.carried_to_next_hours = action === 'carry_forward' ? summary.pending_hours : 0;
  summary.shortfall_decided_by = decidedBy;
  summary.shortfall_decided_on = new Date();
  await summary.save();

  // Refresh next month so carry-in / clear is applied
  const next = nextMonthYear(month, year);
  await recalculateMonthlySummary(employeeId, next.month, next.year);

  return summary;
}
