import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import EarlyCheckoutRequest from '../models/EarlyCheckoutRequest.js';
import CoverTimeRequest, { MIN_COVER_HOURS } from '../models/CoverTimeRequest.js';
import { parseListQuery, listResponse, todayISO, nowTime, nowYearMonth, APP_TIMEZONE, minutesBetween, normalizeTime, parseBreakMinutes, effectiveWorkStart, lateCheckInPenalty, autoLatePenaltyMinutes, normalizePenaltyMinutes } from '../utils/helpers.js';
import { applyEmployeeListScope } from '../utils/employeeScope.js';
import { getEffectiveShiftForEmployee, resolveEffectiveShift } from '../services/shift.js';
import { recalculateAttendanceFields } from '../services/attendanceCalc.js';
import { recalculateForDate, recalculateMonthlySummary } from '../services/monthlyHours.js';
import { closeStaleOpenSessions, isAtOrAfterAutoCheckout } from '../services/autoCheckout.js';
import AuditLog from '../models/AuditLog.js';

function roundHours(h) {
  return Math.round(Number(h || 0) * 10000) / 10000;
}

/** Hours worked past the daily target (cover / OT window). */
function hoursPastDailyTarget(rec, threshold, now, shiftStart, lateBufferMinutes) {
  const workHours = liveWorkMinutes(rec, now, shiftStart, lateBufferMinutes) / 60;
  return Math.max(0, workHours - Number(threshold || 0));
}

function liveBreakMinutes(rec, now) {
  let breakMins = Number(rec.break_total || 0);
  if (rec.check_in && !rec.check_out && rec.break_started_at) {
    breakMins += Math.max(0, minutesBetween(rec.break_started_at, now));
  }
  return breakMins;
}

/**
 * Apply HR/admin late-penalty override from request body.
 * Accepts `penalty_minutes` or `penalty_minutes_override`.
 * Empty / null clears the override (back to default 15m rule).
 * Setting minutes also clears waive; waive alone forces 0 effective minutes.
 */
function applyPenaltyOverride(rec, body = {}) {
  const raw =
    body.penalty_minutes_override !== undefined
      ? body.penalty_minutes_override
      : body.penalty_minutes !== undefined
        ? body.penalty_minutes
        : undefined;
  if (raw === undefined) return;

  if (raw === null || raw === '') {
    rec.penalty_minutes_override = null;
    return;
  }

  const mins = normalizePenaltyMinutes(raw);
  if (mins == null) return;
  rec.penalty_minutes_override = mins;
  // Custom minutes replace waive — explicit 0 is a soft waive via override.
  if (mins > 0) rec.penalty_waived = false;
}

function liveWorkMinutes(rec, now, shiftStart, lateBufferMinutes) {
  if (!rec.check_in) return 0;
  const start = effectiveWorkStart(
    rec.check_in,
    shiftStart,
    !!rec.penalty_waived,
    lateBufferMinutes,
    rec.penalty_minutes_override
  );
  const end = rec.check_out || now;
  const span = Math.max(0, minutesBetween(start, end));
  return Math.max(0, span - liveBreakMinutes(rec, now));
}

function computeLiveStatus(rec, threshold, now, shiftStart, lateBufferMinutes) {
  if (!rec?.check_in) return 'Absent';
  if (rec.check_out) {
    return rec.status || 'OnTime';
  }
  if (rec.break_started_at || rec.status === 'OnBreak') return 'OnBreak';
  const workHours = liveWorkMinutes(rec, now, shiftStart, lateBufferMinutes) / 60;
  if (workHours > Number(threshold || 8.25) + 1 / 120) return 'OnOvertime';
  return 'Working';
}

async function getOrCreateToday(employeeId) {
  const date = todayISO();
  let rec = await Attendance.findOne({ employee_id: employeeId, date });
  if (!rec) rec = await Attendance.create({ employee_id: employeeId, date, status: 'Absent' });
  return rec;
}

export async function myToday(req, res) {
  try {
    await closeStaleOpenSessions({ employeeId: req.user._id });
    const rec = await getOrCreateToday(req.user._id);
    // Keep live status consistent with break flag
    if (rec.check_in && !rec.check_out && rec.break_started_at && rec.status !== 'OnBreak') {
      rec.status = 'OnBreak';
      await rec.save();
    } else if (rec.check_in && !rec.check_out && !rec.break_started_at && rec.status === 'OnBreak') {
      rec.status = 'Working';
      await rec.save();
    }
    const shift = await getEffectiveShiftForEmployee(req.user._id);
    const { month, year } = nowYearMonth();
    const summary = await recalculateMonthlySummary(req.user._id, month, year);
    // Latest early-checkout / cover-time requests for today (if any) so the dashboard can show state.
    const early_checkout_request = await EarlyCheckoutRequest.findOne({
      employee_id: req.user._id,
      date: todayISO(),
    }).sort({ createdAt: -1 });
    const cover_time_request = await CoverTimeRequest.findOne({
      employee_id: req.user._id,
      date: todayISO(),
    }).sort({ createdAt: -1 });
    const penalty = lateCheckInPenalty(
      rec.check_in,
      shift?.shift_start,
      !!rec.penalty_waived,
      shift?.late_buffer_minutes,
      rec.penalty_minutes_override
    );
    const work_start = rec.check_in
      ? effectiveWorkStart(
          rec.check_in,
          shift?.shift_start,
          !!rec.penalty_waived,
          shift?.late_buffer_minutes,
          rec.penalty_minutes_override
        )
      : null;
    res.json({
      attendance: rec,
      shift,
      monthly_summary: summary,
      early_checkout_request,
      cover_time_request,
      cover_time_min_hours: MIN_COVER_HOURS,
      work_start,
      late_minutes: penalty.late_minutes,
      penalty_minutes: penalty.penalty_minutes,
      late_penalty_rule_minutes: autoLatePenaltyMinutes(
        rec.check_in,
        shift?.shift_start,
        shift?.late_buffer_minutes
      ),
      late_buffer_minutes: shift?.late_buffer_minutes,
      date: rec.date,
      now: nowTime(),
      timezone: APP_TIMEZONE,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function checkIn(req, res) {
  try {
    await closeStaleOpenSessions({ employeeId: req.user._id });
    if (isAtOrAfterAutoCheckout()) {
      return res.status(400).json({ message: 'Check-in is closed for today after 11:55 PM auto-checkout' });
    }
    const rec = await getOrCreateToday(req.user._id);
    if (rec.check_in) return res.status(400).json({ message: 'Already checked in' });
    rec.check_in = nowTime();
    rec.status = 'Working';
    rec.auto_checkout = false;
    await rec.save();
    await AuditLog.create({
      action: 'check_in',
      performed_by: req.user._id,
      target_employee_id: req.user._id,
      details: { date: rec.date, check_in: rec.check_in },
    });
    res.json(rec);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function startBreak(req, res) {
  try {
    await closeStaleOpenSessions({ employeeId: req.user._id });
    const rec = await getOrCreateToday(req.user._id);
    if (!rec.check_in || rec.check_out) return res.status(400).json({ message: 'Not working' });
    if (rec.break_started_at) return res.status(400).json({ message: 'Break already started' });
    rec.break_started_at = nowTime();
    rec.status = 'OnBreak';
    await rec.save();
    res.json(rec);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function endBreak(req, res) {
  try {
    await closeStaleOpenSessions({ employeeId: req.user._id });
    const rec = await getOrCreateToday(req.user._id);
    if (!rec.break_started_at) return res.status(400).json({ message: 'No active break' });
    const mins = minutesBetween(rec.break_started_at, nowTime());
    rec.break_total = Number(((rec.break_total || 0) + Math.max(0, mins)).toFixed(4));
    rec.break_started_at = null;
    rec.status = 'Working';
    await rec.save();
    res.json(rec);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function checkOut(req, res) {
  try {
    await closeStaleOpenSessions({ employeeId: req.user._id });
    const rec = await getOrCreateToday(req.user._id);
    if (!rec.check_in) return res.status(400).json({ message: 'Not checked in' });
    if (rec.check_out) {
      if (rec.auto_checkout) return res.json(rec);
      return res.status(400).json({ message: 'Already checked out' });
    }
    const shift = await getEffectiveShiftForEmployee(req.user._id);
    const threshold = Number(shift.working_hours_per_day || 8.25);
    const now = nowTime();

    // Active cover-time request: employee must stay at least 45m past daily hours before checkout.
    const activeCover = await CoverTimeRequest.findOne({
      employee_id: req.user._id,
      date: rec.date,
      status: { $in: ['Pending', 'Approved'] },
    }).sort({ createdAt: -1 });
    if (activeCover) {
      const past = hoursPastDailyTarget(rec, threshold, now, shift.shift_start, shift.late_buffer_minutes);
      if (past + 1 / 120 < MIN_COVER_HOURS) {
        const needMin = Math.ceil((MIN_COVER_HOURS - past) * 60);
        return res.status(400).json({
          message: `Cover time requires at least 45 minutes past daily hours. Stay about ${needMin} more minute(s) before checkout.`,
        });
      }
    }

    if (rec.break_started_at) {
      const mins = minutesBetween(rec.break_started_at, now);
      rec.break_total = Number(((rec.break_total || 0) + Math.max(0, mins)).toFixed(4));
      rec.break_started_at = null;
    }
    rec.check_out = now;
    rec.auto_checkout = false;
    const fields = recalculateAttendanceFields(rec, threshold, shift.shift_start, shift.late_buffer_minutes);
    Object.assign(rec, fields);
    await rec.save();
    await recalculateForDate(req.user._id, rec.date);
    // A normal checkout supersedes any still-pending early checkout request for today.
    await EarlyCheckoutRequest.updateMany(
      { employee_id: req.user._id, date: rec.date, status: 'Pending' },
      {
        $set: {
          status: 'Cancelled',
          decided_by: req.user._id,
          decision_note: 'Employee checked out normally',
          decided_at: new Date(),
        },
      }
    );

    // Lock in actual cover hours from what was worked past the daily target.
    if (activeCover && ['Pending', 'Approved'].includes(activeCover.status)) {
      const excess = Math.max(0, Number(rec.working_hours || 0) - threshold);
      activeCover.actual_cover_hours = roundHours(Math.min(Number(activeCover.requested_hours) || 0, excess));
      await activeCover.save();
      await recalculateForDate(req.user._id, rec.date);
    }

    await AuditLog.create({
      action: 'check_out',
      performed_by: req.user._id,
      target_employee_id: req.user._id,
      details: {
        date: rec.date,
        check_in: rec.check_in,
        check_out: rec.check_out,
        status: rec.status,
        working_hours: rec.working_hours,
        cover_hours: activeCover?.actual_cover_hours || 0,
      },
    });
    res.json(rec);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

/* ── Early checkout request workflow ─────────────────────────────── */

export async function createEarlyCheckoutRequest(req, res) {
  try {
    await closeStaleOpenSessions({ employeeId: req.user._id });
    const rec = await getOrCreateToday(req.user._id);
    if (!rec.check_in) return res.status(400).json({ message: 'Not checked in' });
    if (rec.check_out) return res.status(400).json({ message: 'Already checked out' });
    const existing = await EarlyCheckoutRequest.findOne({
      employee_id: req.user._id,
      date: todayISO(),
      status: 'Pending',
    });
    if (existing) return res.status(400).json({ message: 'An early checkout request is already pending' });
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ message: 'Reason is required' });
    const request = await EarlyCheckoutRequest.create({
      employee_id: req.user._id,
      attendance_id: rec._id,
      date: todayISO(),
      requested_time: nowTime(),
      reason,
      status: 'Pending',
    });
    await AuditLog.create({
      action: 'early_checkout_requested',
      performed_by: req.user._id,
      target_employee_id: req.user._id,
      details: { date: request.date, requested_time: request.requested_time, reason },
    });
    res.status(201).json(request);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function listEarlyCheckoutRequests(req, res) {
  try {
    const { page, limit, skip } = parseListQuery(req.query);
    const filter = {};
    if (req.user.role === 'employee') {
      filter.employee_id = req.user._id;
    } else if (req.query.employee_id) {
      filter.employee_id = req.query.employee_id;
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.date) {
      filter.date = req.query.date;
    } else if (req.query.month && req.query.year) {
      const m = String(req.query.month).padStart(2, '0');
      filter.date = { $regex: `^${req.query.year}-${m}` };
    } else if (req.query.year) {
      filter.date = { $regex: `^${req.query.year}` };
    } else if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = req.query.from;
      if (req.query.to) filter.date.$lte = req.query.to;
    }
    const [data, total] = await Promise.all([
      EarlyCheckoutRequest.find(filter)
        .populate({ path: 'employee_id', populate: { path: 'department_id' } })
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit),
      EarlyCheckoutRequest.countDocuments(filter),
    ]);
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function decideEarlyCheckoutRequest(req, res) {
  try {
    const request = await EarlyCheckoutRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.status !== 'Pending') {
      return res.status(400).json({ message: `Request already ${request.status.toLowerCase()}` });
    }
    const decision = req.body.status;
    if (decision !== 'Approved' && decision !== 'Rejected') {
      return res.status(400).json({ message: 'status must be Approved or Rejected' });
    }
    if (String(request.employee_id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot decide your own early checkout request' });
    }
    request.status = decision;
    request.decided_by = req.user._id;
    request.decided_at = new Date();
    request.decision_note = String(req.body.note || '').trim();

    if (decision === 'Approved') {
      const rec = await Attendance.findById(request.attendance_id);
      if (rec && !rec.check_out) {
        if (rec.break_started_at) {
          const mins = minutesBetween(rec.break_started_at, request.requested_time);
          rec.break_total = Number(((rec.break_total || 0) + Math.max(0, mins)).toFixed(4));
          rec.break_started_at = null;
        }
        rec.check_out = request.requested_time;
        const shift = await getEffectiveShiftForEmployee(rec.employee_id);
        Object.assign(rec, recalculateAttendanceFields(rec, shift.working_hours_per_day, shift.shift_start, shift.late_buffer_minutes));
        await rec.save();
        await recalculateForDate(rec.employee_id, rec.date);
      }
    }

    await request.save();
    await AuditLog.create({
      action: `early_checkout_${decision === 'Approved' ? 'approved' : 'rejected'}`,
      performed_by: req.user._id,
      target_employee_id: request.employee_id,
      details: {
        date: request.date,
        requested_time: request.requested_time,
        note: request.decision_note,
      },
    });
    res.json(request);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function cancelEarlyCheckoutRequest(req, res) {
  try {
    const request = await EarlyCheckoutRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.status !== 'Pending') {
      return res.status(400).json({ message: `Request already ${request.status.toLowerCase()}` });
    }
    // Employees can only cancel their own requests.
    if (String(request.employee_id) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    request.status = 'Cancelled';
    request.decided_by = req.user._id;
    request.decided_at = new Date();
    request.decision_note = 'Cancelled by employee';
    await request.save();
    await AuditLog.create({
      action: 'early_checkout_cancelled',
      performed_by: req.user._id,
      target_employee_id: req.user._id,
      details: { date: request.date, requested_time: request.requested_time },
    });
    res.json(request);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

/* ── Cover time request workflow ─────────────────────────────────── */

export async function createCoverTimeRequest(req, res) {
  try {
    await closeStaleOpenSessions({ employeeId: req.user._id });
    const rec = await getOrCreateToday(req.user._id);
    if (!rec.check_in) return res.status(400).json({ message: 'Not checked in' });
    if (rec.check_out) return res.status(400).json({ message: 'Already checked out' });

    const shift = await getEffectiveShiftForEmployee(req.user._id);
    const threshold = Number(shift.working_hours_per_day || 8.25);
    const now = nowTime();
    const workHours = liveWorkMinutes(rec, now, shift.shift_start, shift.late_buffer_minutes) / 60;
    if (workHours + 1 / 120 < threshold) {
      return res.status(400).json({
        message: `Cover time can only be requested after completing daily working hours (${threshold}h).`,
      });
    }

    const existing = await CoverTimeRequest.findOne({
      employee_id: req.user._id,
      date: todayISO(),
      status: { $in: ['Pending', 'Approved'] },
    });
    if (existing) {
      return res.status(400).json({ message: 'A cover time request is already active for today' });
    }

    const hrs = Number(req.body.hours ?? req.body.requested_hours);
    if (!Number.isFinite(hrs) || hrs < MIN_COVER_HOURS) {
      return res.status(400).json({
        message: `Cover time must be at least ${MIN_COVER_HOURS * 60} minutes (0.75h)`,
      });
    }
    if (hrs > 12) return res.status(400).json({ message: 'Cover time cannot exceed 12 hours' });

    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ message: 'Reason is required' });

    const { month, year } = nowYearMonth();
    const summary = await recalculateMonthlySummary(req.user._id, month, year);
    const pending = Number(summary?.pending_hours || 0);
    if (pending < MIN_COVER_HOURS - 0.001) {
      return res.status(400).json({
        message: 'No monthly shortfall hours to cover. Cover time is only for making up pending working hours.',
      });
    }
    if (hrs > pending + 0.01) {
      return res.status(400).json({
        message: `You can cover at most ${roundHours(pending)}h (your current monthly shortfall).`,
      });
    }

    const request = await CoverTimeRequest.create({
      employee_id: req.user._id,
      attendance_id: rec._id,
      date: todayISO(),
      requested_hours: roundHours(hrs),
      reason,
      status: 'Pending',
    });
    await AuditLog.create({
      action: 'cover_time_requested',
      performed_by: req.user._id,
      target_employee_id: req.user._id,
      details: { date: request.date, requested_hours: request.requested_hours, reason },
    });
    res.status(201).json(request);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function listCoverTimeRequests(req, res) {
  try {
    const { page, limit, skip } = parseListQuery(req.query);
    const filter = {};
    if (req.user.role === 'employee') {
      filter.employee_id = req.user._id;
    } else if (req.query.employee_id) {
      filter.employee_id = req.query.employee_id;
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.date) {
      filter.date = req.query.date;
    } else if (req.query.month && req.query.year) {
      const m = String(req.query.month).padStart(2, '0');
      filter.date = { $regex: `^${req.query.year}-${m}` };
    } else if (req.query.year) {
      filter.date = { $regex: `^${req.query.year}` };
    } else if (req.query.from || req.query.to) {
      filter.date = {};
      if (req.query.from) filter.date.$gte = req.query.from;
      if (req.query.to) filter.date.$lte = req.query.to;
    }
    const [data, total] = await Promise.all([
      CoverTimeRequest.find(filter)
        .populate({ path: 'employee_id', populate: { path: 'department_id' } })
        .populate('decided_by', 'name')
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit),
      CoverTimeRequest.countDocuments(filter),
    ]);
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function decideCoverTimeRequest(req, res) {
  try {
    const request = await CoverTimeRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.status !== 'Pending') {
      return res.status(400).json({ message: `Request already ${request.status.toLowerCase()}` });
    }
    const decision = req.body.status;
    if (decision !== 'Approved' && decision !== 'Rejected') {
      return res.status(400).json({ message: 'status must be Approved or Rejected' });
    }
    if (String(request.employee_id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot decide your own cover time request' });
    }

    // Prefer actual hours from checkout; if still open, use live excess capped at requested.
    const rec = await Attendance.findById(request.attendance_id);
    const shift = await getEffectiveShiftForEmployee(request.employee_id);
    const threshold = Number(shift?.working_hours_per_day || 8.25);
    let actual = Number(request.actual_cover_hours || 0);
    if (rec?.check_out) {
      const excess = Math.max(0, Number(rec.working_hours || 0) - threshold);
      actual = roundHours(Math.min(Number(request.requested_hours) || 0, excess));
    } else if (rec?.check_in) {
      const past = hoursPastDailyTarget(
        rec,
        threshold,
        nowTime(),
        shift.shift_start,
        shift.late_buffer_minutes
      );
      actual = roundHours(Math.min(Number(request.requested_hours) || 0, past));
    }

    if (decision === 'Approved' && actual + 0.001 < MIN_COVER_HOURS) {
      return res.status(400).json({
        message: 'Cannot approve: employee has not completed at least 45 minutes of cover time yet.',
      });
    }

    request.status = decision;
    request.actual_cover_hours = decision === 'Approved' ? actual : 0;
    request.decided_by = req.user._id;
    request.decided_at = new Date();
    request.decision_note = String(req.body.note || '').trim();
    await request.save();
    await recalculateForDate(request.employee_id, request.date);

    await AuditLog.create({
      action: `cover_time_${decision === 'Approved' ? 'approved' : 'rejected'}`,
      performed_by: req.user._id,
      target_employee_id: request.employee_id,
      details: {
        date: request.date,
        requested_hours: request.requested_hours,
        actual_cover_hours: request.actual_cover_hours,
        note: request.decision_note,
      },
    });
    const populated = await CoverTimeRequest.findById(request._id)
      .populate({ path: 'employee_id', populate: { path: 'department_id' } })
      .populate('decided_by', 'name');
    res.json(populated);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function cancelCoverTimeRequest(req, res) {
  try {
    const request = await CoverTimeRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.status !== 'Pending') {
      return res.status(400).json({ message: `Request already ${request.status.toLowerCase()}` });
    }
    if (String(request.employee_id) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    request.status = 'Cancelled';
    request.actual_cover_hours = 0;
    request.decided_by = req.user._id;
    request.decided_at = new Date();
    request.decision_note = 'Cancelled by employee';
    await request.save();
    await recalculateForDate(request.employee_id, request.date);
    await AuditLog.create({
      action: 'cover_time_cancelled',
      performed_by: req.user._id,
      target_employee_id: req.user._id,
      details: { date: request.date, requested_hours: request.requested_hours },
    });
    res.json(request);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    // Auto-checkout days (forgotten open session closed at 11:55 PM) do not earn
    // attendance OT — same rule as monthlyHours / the Overtime page. Allow the
    // UI to count status Extra days that actually carry OT.
    if (req.query.exclude_auto_checkout === '1' || req.query.exclude_auto_checkout === 'true') {
      filter.auto_checkout = { $ne: true };
    }

    const isoDate = (value) => {
      const s = String(value || '').trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    };
    const exactDate = isoDate(req.query.date);
    const from = isoDate(req.query.from || req.query.date_from);
    const to = isoDate(req.query.to || req.query.date_to);
    if (exactDate) {
      filter.date = exactDate;
    } else if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    } else if (req.query.month && req.query.year) {
      const m = String(req.query.month).padStart(2, '0');
      filter.date = { $regex: `^${req.query.year}-${m}` };
    } else if (req.query.year) {
      filter.date = { $regex: `^${req.query.year}` };
    }

    await applyEmployeeListScope(req, filter, { search });

    const [docs, total] = await Promise.all([
      Attendance.find(filter).populate({ path: 'employee_id', populate: { path: 'department_id' } }).sort({ date: -1 }).skip(skip).limit(limit),
      Attendance.countDocuments(filter),
    ]);
    // Ensure live break shows as OnBreak even if status field is stale
    const data = docs.map((doc) => {
      const o = doc.toObject();
      if (o.check_in && !o.check_out && o.break_started_at) {
        o.status = 'OnBreak';
      }
      return o;
    });
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function update(req, res) {
  try {
    const rec = await Attendance.findById(req.params.id);
    if (!rec) return res.status(404).json({ message: 'Not found' });
    const { check_in, check_out, break_total, break_started_at, penalty_waived, end_break } = req.body;
    if (check_in !== undefined) rec.check_in = normalizeTime(check_in);
    if (check_out !== undefined) {
      rec.check_out = normalizeTime(check_out);
      rec.auto_checkout = false;
    }
    if (break_total !== undefined) rec.break_total = Number(parseBreakMinutes(break_total).toFixed(4));
    if (penalty_waived !== undefined) rec.penalty_waived = !!penalty_waived;
    applyPenaltyOverride(rec, req.body);
    if (end_break) {
      if (rec.break_started_at) {
        const mins = minutesBetween(rec.break_started_at, nowTime());
        rec.break_total = Number(((rec.break_total || 0) + Math.max(0, mins)).toFixed(4));
        rec.break_started_at = null;
      }
    } else if (break_started_at !== undefined) {
      rec.break_started_at = break_started_at ? normalizeTime(break_started_at) : null;
    }
    const shift = await getEffectiveShiftForEmployee(rec.employee_id);
    const fields = recalculateAttendanceFields(rec, shift.working_hours_per_day, shift.shift_start, shift.late_buffer_minutes);
    Object.assign(rec, fields);
    await rec.save();
    await recalculateForDate(rec.employee_id, rec.date);
    res.json(rec);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

/** Admin/HR: live today board for all active employees */
export async function listToday(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const date = req.query.date || todayISO();
    await closeStaleOpenSessions();
    const empFilter = { status: 'active', role: 'employee' };
    if (req.query.department_id) empFilter.department_id = req.query.department_id;
    if (search) {
      empFilter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { employee_id: { $regex: search, $options: 'i' } },
      ];
    }

    const employees = await Employee.find(empFilter)
      .populate('department_id')
      .sort({ name: 1 })
      .lean();

    const ids = employees.map((e) => e._id);
    const attRows = await Attendance.find({ employee_id: { $in: ids }, date }).lean();
    const attByEmp = new Map(attRows.map((a) => [String(a.employee_id), a]));
    const now = nowTime();

    let rows = employees.map((emp) => {
      const att = attByEmp.get(String(emp._id)) || null;
      const shift = resolveEffectiveShift(emp, emp.department_id);
      const threshold = shift.working_hours_per_day ?? 8.25;
      const live_status = computeLiveStatus(att, threshold, now, shift.shift_start, shift.late_buffer_minutes);
      const workMins = att ? liveWorkMinutes(att, now, shift.shift_start, shift.late_buffer_minutes) : 0;
      const breakMins = att ? liveBreakMinutes(att, now) : 0;
      const penalty = lateCheckInPenalty(
        att?.check_in,
        shift.shift_start,
        !!att?.penalty_waived,
        shift.late_buffer_minutes,
        att?.penalty_minutes_override
      );
      const work_start = att?.check_in
        ? effectiveWorkStart(
            att.check_in,
            shift.shift_start,
            !!att.penalty_waived,
            shift.late_buffer_minutes,
            att.penalty_minutes_override
          )
        : null;
      return {
        employee: {
          _id: emp._id,
          name: emp.name,
          employee_id: emp.employee_id,
          email: emp.email,
          department_id: emp.department_id
            ? { _id: emp.department_id._id, name: emp.department_id.name }
            : null,
        },
        date,
        attendance_id: att?._id || null,
        check_in: att?.check_in || null,
        check_out: att?.check_out || null,
        auto_checkout: !!att?.auto_checkout,
        work_start,
        break_total: att?.break_total || 0,
        break_started_at: att?.break_started_at || null,
        working_hours: att?.check_out ? att.working_hours || 0 : workMins / 60,
        live_work_minutes: Math.round(workMins * 100) / 100,
        live_break_minutes: Math.round(breakMins * 100) / 100,
        status: att?.status || 'Absent',
        live_status,
        surplus_shortfall: att?.surplus_shortfall || 0,
        penalty_waived: !!att?.penalty_waived,
        penalty_minutes_override:
          att?.penalty_minutes_override == null ? null : Number(att.penalty_minutes_override),
        late_minutes: penalty.late_minutes,
        penalty_minutes: penalty.penalty_minutes,
        late_penalty_rule_minutes: autoLatePenaltyMinutes(
          att?.check_in,
          shift.shift_start,
          shift.late_buffer_minutes
        ),
        late_buffer_minutes: shift.late_buffer_minutes,
        shift: {
          shift_start: shift.shift_start,
          shift_end: shift.shift_end,
          working_hours_per_day: threshold,
          late_buffer_minutes: shift.late_buffer_minutes,
        },
      };
    });

    const counts = rows.reduce(
      (acc, r) => {
        acc[r.live_status] = (acc[r.live_status] || 0) + 1;
        return acc;
      },
      { Working: 0, OnBreak: 0, OnOvertime: 0, Absent: 0, Extra: 0, Low: 0, OnTime: 0 }
    );

    if (req.query.live_status) {
      rows = rows.filter((r) => r.live_status === req.query.live_status);
    }

    const total = rows.length;
    const data = rows.slice(skip, skip + limit);

    res.json({ ...listResponse(data, total, page, limit), date, counts, now });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

/** Admin/HR: create/update today's attendance for one employee */
export async function updateToday(req, res) {
  try {
    const employeeId = req.params.employeeId;
    const emp = await Employee.findById(employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const date = req.body.date || todayISO();
    let rec = await Attendance.findOne({ employee_id: employeeId, date });
    if (!rec) {
      rec = await Attendance.create({ employee_id: employeeId, date, status: 'Absent' });
    }

    const { check_in, check_out, break_total, break_started_at, penalty_waived, end_break } = req.body;

    if (check_in !== undefined) rec.check_in = check_in === null || check_in === '' ? null : normalizeTime(check_in);
    if (check_out !== undefined) {
      rec.check_out = check_out === null || check_out === '' ? null : normalizeTime(check_out);
      rec.auto_checkout = false;
    }
    if (break_total !== undefined) rec.break_total = Number(parseBreakMinutes(break_total).toFixed(4));
    if (penalty_waived !== undefined) rec.penalty_waived = !!penalty_waived;
    applyPenaltyOverride(rec, req.body);

    if (end_break) {
      if (rec.break_started_at) {
        const mins = minutesBetween(rec.break_started_at, nowTime());
        rec.break_total = Number(((rec.break_total || 0) + Math.max(0, mins)).toFixed(4));
      }
      rec.break_started_at = null;
    } else if (break_started_at !== undefined) {
      rec.break_started_at = break_started_at ? normalizeTime(break_started_at) : null;
    }

    // If check-in cleared, reset day
    if (!rec.check_in) {
      rec.check_out = null;
      rec.break_started_at = null;
      rec.working_hours = 0;
      rec.surplus_shortfall = 0;
      rec.status = 'Absent';
      rec.auto_checkout = false;
    } else {
      const shift = await getEffectiveShiftForEmployee(employeeId);
      Object.assign(rec, recalculateAttendanceFields(rec, shift.working_hours_per_day, shift.shift_start, shift.late_buffer_minutes));
    }

    await rec.save();
    await recalculateForDate(employeeId, date);
    await AuditLog.create({
      action: 'today_attendance_update',
      performed_by: req.user._id,
      target_employee_id: employeeId,
      details: {
        date,
        check_in: rec.check_in,
        check_out: rec.check_out,
        break_total: rec.break_total,
        break_started_at: rec.break_started_at,
        penalty_waived: rec.penalty_waived,
        penalty_minutes_override: rec.penalty_minutes_override,
      },
    });

    const shift = await getEffectiveShiftForEmployee(employeeId);
    const now = nowTime();
    const live_status = computeLiveStatus(rec.toObject(), shift.working_hours_per_day, now, shift.shift_start, shift.late_buffer_minutes);
    const penalty = lateCheckInPenalty(
      rec.check_in,
      shift.shift_start,
      !!rec.penalty_waived,
      shift.late_buffer_minutes,
      rec.penalty_minutes_override
    );
    res.json({
      ...rec.toObject(),
      live_status,
      work_start: rec.check_in
        ? effectiveWorkStart(
            rec.check_in,
            shift.shift_start,
            !!rec.penalty_waived,
            shift.late_buffer_minutes,
            rec.penalty_minutes_override
          )
        : null,
      late_minutes: penalty.late_minutes,
      penalty_minutes: penalty.penalty_minutes,
      late_penalty_rule_minutes: autoLatePenaltyMinutes(
        rec.check_in,
        shift.shift_start,
        shift.late_buffer_minutes
      ),
      late_buffer_minutes: shift.late_buffer_minutes,
      shift: {
        shift_start: shift.shift_start,
        shift_end: shift.shift_end,
        working_hours_per_day: shift.working_hours_per_day,
        late_buffer_minutes: shift.late_buffer_minutes,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function bulkRecalc(req, res) {
  try {
    const { department_id, month, year } = req.body;
    const filter = {};
    if (department_id) filter.department_id = department_id;
    filter.role = 'employee';
    const emps = await Employee.find(filter).select('_id');
    let count = 0;
    for (const e of emps) {
      await recalculateMonthlySummary(e._id, Number(month), Number(year));
      count++;
    }
    await AuditLog.create({
      action: 'bulk_recalc',
      performed_by: req.user._id,
      details: { department_id, month, year, employees: count },
    });
    res.json({ message: 'Recalculated', employees: count });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function bulkUpdate(req, res) {
  try {
    const { updates } = req.body; // [{ id, check_in, check_out, break_total }]
    if (!Array.isArray(updates)) return res.status(400).json({ message: 'updates array required' });
    const results = [];
    for (const u of updates) {
      const rec = await Attendance.findById(u.id);
      if (!rec) continue;
      if (u.check_in !== undefined) rec.check_in = normalizeTime(u.check_in);
      if (u.check_out !== undefined) {
        rec.check_out = normalizeTime(u.check_out);
        rec.auto_checkout = false;
      }
      if (u.break_total !== undefined) rec.break_total = Number(parseBreakMinutes(u.break_total).toFixed(4));
      const shift = await getEffectiveShiftForEmployee(rec.employee_id);
      Object.assign(rec, recalculateAttendanceFields(rec, shift.working_hours_per_day, shift.shift_start, shift.late_buffer_minutes));
      await rec.save();
      await recalculateForDate(rec.employee_id, rec.date);
      results.push(rec);
    }
    await AuditLog.create({
      action: 'bulk_attendance_update',
      performed_by: req.user._id,
      details: { count: results.length },
    });
    res.json({ updated: results.length, data: results });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
