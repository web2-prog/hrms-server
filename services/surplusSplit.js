/**
 * Daily surplus for Cover Time + Management OT.
 *
 *   Daily Surplus = max(0, worked − daily target)  // through checkout or live now
 *
 * Cover Time only consumes surplus when an actual Cover request exists for the day.
 * Until then, Management OT can use the full surplus (worked past daily hours).
 *
 *   claimed_cover     = Pending/Approved cover hours for the day (else 0)
 *   Management OT     = Daily Surplus − claimed_cover
 *   Cover (potential) = min(Daily Surplus − claimed_mgmt_ot, monthly shortfall)
 *
 * Same worked minutes must never count as both once claimed.
 */
import Attendance from '../models/Attendance.js';
import CoverTimeRequest, { MIN_COVER_HOURS } from '../models/CoverTimeRequest.js';
import OvertimeRequest from '../models/OvertimeRequest.js';
import {
  todayISO,
  nowTime,
  nowYearMonth,
  minutesBetween,
  effectiveWorkStart,
  formatHoursHm,
  hoursToMinutes,
} from '../utils/helpers.js';
import { getEffectiveShiftForEmployee } from './shift.js';
import { recalculateMonthlySummary } from './monthlyHours.js';

export { MIN_COVER_HOURS };

export function roundHours(h) {
  return Math.round(Number(h || 0) * 100) / 100;
}

/** Live / closed-day work minutes (matches attendance check-out rules). */
export function workMinutesFromAttendance(rec, now, shiftStart, lateBufferMinutes) {
  if (!rec?.check_in) return 0;
  const start = effectiveWorkStart(
    rec.check_in,
    shiftStart,
    !!rec.penalty_waived,
    lateBufferMinutes,
    rec.penalty_minutes_override
  );
  const end = rec.check_out || now;
  let breakMins = Number(rec.break_total || 0);
  if (!rec.check_out && rec.break_started_at) {
    breakMins += Math.max(0, minutesBetween(rec.break_started_at, now));
  }
  const span = Math.max(0, minutesBetween(start, end));
  return Math.max(0, span - breakMins);
}

/**
 * Pure split given known surplus + shortfall + optional claimed cover / mgmt OT.
 * @param {number} dailySurplus
 * @param {number} monthlyShortfall pending monthly hours
 * @param {number|null} existingCoverHours Pending/Approved cover for this day (locks that slice)
 * @param {number|null} existingMgmtOtHours Pending/Approved Management OT for this day
 */
export function splitDailySurplus(
  dailySurplus,
  monthlyShortfall,
  existingCoverHours = null,
  existingMgmtOtHours = null
) {
  const surplus = Math.max(0, Number(dailySurplus) || 0);
  const shortfall = Math.max(0, Number(monthlyShortfall) || 0);
  const claimedCover =
    existingCoverHours != null && Number(existingCoverHours) > 0
      ? roundHours(Math.min(surplus, Number(existingCoverHours)))
      : 0;
  const claimedMgmt =
    existingMgmtOtHours != null && Number(existingMgmtOtHours) > 0
      ? roundHours(Math.min(surplus, Number(existingMgmtOtHours)))
      : 0;

  // Management OT = full surplus past daily hours, minus only an actual cover claim.
  const management_ot_hours = roundHours(Math.max(0, surplus - claimedCover));

  // Cover request size = leftover after any claimed Management OT, capped by shortfall.
  // Do not pre-reserve cover against Management OT when neither is claimed.
  const availableForCover = roundHours(Math.max(0, surplus - claimedMgmt));
  const cover_hours = claimedCover > 0
    ? claimedCover
    : roundHours(Math.min(availableForCover, shortfall));

  return {
    daily_surplus: roundHours(surplus),
    monthly_shortfall: roundHours(shortfall),
    cover_hours,
    management_ot_hours,
    remaining_surplus: management_ot_hours,
    claimed_cover_hours: claimedCover,
    claimed_management_ot_hours: claimedMgmt,
  };
}

/**
 * Full attendance-based surplus split for an employee on a date.
 * Backend source of truth for Cover Time + Management OT hours.
 */
export async function computeSurplusSplit(employeeId, date = todayISO()) {
  const shift = await getEffectiveShiftForEmployee(employeeId);
  if (!shift) {
    return {
      ok: false,
      status: 404,
      message: 'Employee shift not found',
      date,
      daily_surplus: 0,
      cover_hours: 0,
      management_ot_hours: 0,
      monthly_shortfall: 0,
      full_hours: 8.25,
      work_hours: 0,
      checked_in: false,
      checked_out: false,
      cover_eligible: false,
      management_ot_eligible: false,
      has_active_cover: false,
      has_active_management_ot: false,
      min_cover_hours: MIN_COVER_HOURS,
    };
  }

  const fullHours = Number(shift.working_hours_per_day || 8.25);
  const att = await Attendance.findOne({ employee_id: employeeId, date });
  const now = nowTime();
  const workMins = att?.check_in
    ? workMinutesFromAttendance(att, now, shift.shift_start, shift.late_buffer_minutes)
    : 0;
  const workHours = workMins / 60;
  const dailySurplus = Math.max(0, workHours - fullHours);

  const [y, m] = date.split('-').map(Number);
  const { month: curM, year: curY } = nowYearMonth();
  const summary = await recalculateMonthlySummary(employeeId, m || curM, y || curY);
  const monthlyShortfall = Number(summary?.pending_hours || 0);

  const activeCover = await CoverTimeRequest.findOne({
    employee_id: employeeId,
    date,
    status: { $in: ['Pending', 'Approved'] },
  }).sort({ createdAt: -1 });

  const activeMgmtOt = await OvertimeRequest.findOne({
    employee_id: employeeId,
    date,
    status: { $in: ['Pending', 'Approved'] },
    ot_type: 'Management',
  }).sort({ createdAt: -1 });

  const existingCoverClaim = activeCover
    ? Number(activeCover.actual_cover_hours) > 0
      ? Number(activeCover.actual_cover_hours)
      : Number(activeCover.requested_hours) || 0
    : null;

  const existingMgmtClaim = activeMgmtOt ? Number(activeMgmtOt.hours) || 0 : null;

  const split = splitDailySurplus(
    dailySurplus,
    monthlyShortfall,
    existingCoverClaim,
    existingMgmtClaim
  );

  const checkedIn = !!att?.check_in;
  const checkedOut = !!att?.check_out;
  const dailyTargetMet = workHours + 1 / 120 >= fullHours;

  // Cover: only while still working; needs shortfall + surplus; blocked if cover or mgmt already claimed full surplus.
  const cover_eligible =
    checkedIn &&
    !checkedOut &&
    dailyTargetMet &&
    !activeCover &&
    !activeMgmtOt &&
    monthlyShortfall + 0.001 >= MIN_COVER_HOURS &&
    split.cover_hours + 0.001 >= MIN_COVER_HOURS;

  // Management OT: surplus from daily hours through checkout/now, minus actual cover only.
  const management_ot_eligible =
    checkedIn &&
    !activeMgmtOt &&
    dailyTargetMet &&
    split.management_ot_hours >= 0.01;

  let cover_message = null;
  if (!checkedIn) cover_message = 'Check in first';
  else if (checkedOut) cover_message = 'Already checked out';
  else if (!dailyTargetMet) cover_message = `Complete daily hours (${formatHoursHm(fullHours)}) first`;
  else if (activeCover) cover_message = 'A cover time request is already active for this date';
  else if (activeMgmtOt) {
    cover_message = 'Management OT already requested for this date — surplus is not available for Cover Time';
  } else if (monthlyShortfall < MIN_COVER_HOURS - 0.001) {
    cover_message = 'No monthly shortfall to cover';
  } else if (split.cover_hours + 0.001 < MIN_COVER_HOURS) {
    cover_message = `Need at least ${formatHoursHm(MIN_COVER_HOURS)} of surplus toward shortfall (cover slice ${formatHoursHm(split.cover_hours)})`;
  }

  let management_ot_message = null;
  if (!checkedIn) {
    management_ot_message =
      'Check in, complete daily working hours, and work through to checkout before requesting Management OT';
  } else if (activeMgmtOt) {
    management_ot_message =
      activeMgmtOt.status === 'Pending'
        ? 'A Management OT request is already pending for this date'
        : 'Management OT is already approved for this date';
  } else if (!dailyTargetMet || split.management_ot_hours < 0.01) {
    if (split.claimed_cover_hours > 0.01 && split.daily_surplus > 0.01) {
      management_ot_message = `Cover Time already claimed ${formatHoursHm(split.claimed_cover_hours)} of today's surplus. No remaining Management OT.`;
    } else {
      management_ot_message = checkedOut
        ? `No Management OT for this day. Worked ${formatHoursHm(workHours)} through checkout vs daily ${formatHoursHm(fullHours)}.`
        : `No Management OT yet. Work beyond ${formatHoursHm(fullHours)} through checkout (currently ${formatHoursHm(workHours)} worked).`;
    }
  }

  return {
    ok: true,
    date,
    work_hours: roundHours(workHours),
    work_minutes: hoursToMinutes(workHours),
    full_hours: fullHours,
    full_minutes: hoursToMinutes(fullHours),
    checked_in: checkedIn,
    checked_out: checkedOut,
    daily_target_met: dailyTargetMet,
    ...split,
    daily_surplus_minutes: hoursToMinutes(split.daily_surplus),
    cover_minutes: hoursToMinutes(split.cover_hours),
    management_ot_minutes: hoursToMinutes(split.management_ot_hours),
    monthly_shortfall_minutes: hoursToMinutes(split.monthly_shortfall),
    cover_eligible,
    management_ot_eligible,
    has_active_cover: !!activeCover,
    has_active_management_ot: !!activeMgmtOt,
    active_cover_hours: existingCoverClaim != null ? roundHours(existingCoverClaim) : 0,
    active_cover_minutes: existingCoverClaim != null ? hoursToMinutes(existingCoverClaim) : 0,
    min_cover_hours: MIN_COVER_HOURS,
    min_cover_minutes: hoursToMinutes(MIN_COVER_HOURS),
    cover_message,
    management_ot_message,
  };
}
