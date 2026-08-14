import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import EarlyCheckoutRequest from '../models/EarlyCheckoutRequest.js';
import { parseListQuery, listResponse, todayISO, nowTime, minutesBetween, normalizeTime, parseBreakMinutes, effectiveWorkStart, lateCheckInPenalty, LATE_CHECKIN_PENALTY_MINUTES } from '../utils/helpers.js';
import { applyEmployeeListScope } from '../utils/employeeScope.js';
import { getEffectiveShiftForEmployee, resolveEffectiveShift } from '../services/shift.js';
import { recalculateAttendanceFields } from '../services/attendanceCalc.js';
import { recalculateForDate, recalculateMonthlySummary } from '../services/monthlyHours.js';
import { closeStaleOpenSessions, isAtOrAfterAutoCheckout } from '../services/autoCheckout.js';
import AuditLog from '../models/AuditLog.js';

function liveBreakMinutes(rec, now) {
  let breakMins = Number(rec.break_total || 0);
  if (rec.check_in && !rec.check_out && rec.break_started_at) {
    breakMins += Math.max(0, minutesBetween(rec.break_started_at, now));
  }
  return breakMins;
}

function liveWorkMinutes(rec, now, shiftStart) {
  if (!rec.check_in) return 0;
  const start = effectiveWorkStart(rec.check_in, shiftStart, !!rec.penalty_waived);
  const end = rec.check_out || now;
  const span = Math.max(0, minutesBetween(start, end));
  return Math.max(0, span - liveBreakMinutes(rec, now));
}

function computeLiveStatus(rec, threshold, now, shiftStart) {
  if (!rec?.check_in) return 'Absent';
  if (rec.check_out) {
    return rec.status || 'OnTime';
  }
  if (rec.break_started_at || rec.status === 'OnBreak') return 'OnBreak';
  const workHours = liveWorkMinutes(rec, now, shiftStart) / 60;
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
    const month = new Date().getMonth() + 1;
    const year = new Date().getFullYear();
    const summary = await recalculateMonthlySummary(req.user._id, month, year);
    // Latest early-checkout request for today (if any) so the dashboard can show pending/decided state.
    const early_checkout_request = await EarlyCheckoutRequest.findOne({
      employee_id: req.user._id,
      date: todayISO(),
    }).sort({ createdAt: -1 });
    const penalty = lateCheckInPenalty(rec.check_in, shift?.shift_start, !!rec.penalty_waived);
    const work_start = rec.check_in
      ? effectiveWorkStart(rec.check_in, shift?.shift_start, !!rec.penalty_waived)
      : null;
    res.json({
      attendance: rec,
      shift,
      monthly_summary: summary,
      early_checkout_request,
      work_start,
      late_minutes: penalty.late_minutes,
      penalty_minutes: penalty.penalty_minutes,
      late_penalty_rule_minutes: LATE_CHECKIN_PENALTY_MINUTES,
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
    if (rec.break_started_at) {
      const mins = minutesBetween(rec.break_started_at, nowTime());
      rec.break_total = Number(((rec.break_total || 0) + Math.max(0, mins)).toFixed(4));
      rec.break_started_at = null;
    }
    rec.check_out = nowTime();
    rec.auto_checkout = false;
    const shift = await getEffectiveShiftForEmployee(req.user._id);
    const fields = recalculateAttendanceFields(rec, shift.working_hours_per_day, shift.shift_start, shift.shift_end);
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
    } else {
      if (req.query.status) filter.status = req.query.status;
      if (req.query.date) filter.date = req.query.date;
    }
    const [data, total] = await Promise.all([
      EarlyCheckoutRequest.find(filter)
        .populate({ path: 'employee_id', populate: { path: 'department_id' } })
        .sort({ createdAt: -1 })
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
        Object.assign(rec, recalculateAttendanceFields(rec, shift.working_hours_per_day, shift.shift_start, shift.shift_end));
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

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.month && req.query.year) {
      const m = String(req.query.month).padStart(2, '0');
      filter.date = { $regex: `^${req.query.year}-${m}` };
    } else if (req.query.year) {
      filter.date = { $regex: `^${req.query.year}` };
    }
    await applyEmployeeListScope(req, filter, { search });

    const [data, total] = await Promise.all([
      Attendance.find(filter).populate({ path: 'employee_id', populate: { path: 'department_id' } }).sort({ date: -1 }).skip(skip).limit(limit),
      Attendance.countDocuments(filter),
    ]);
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
    const fields = recalculateAttendanceFields(rec, shift.working_hours_per_day, shift.shift_start, shift.shift_end);
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
      const live_status = computeLiveStatus(att, threshold, now, shift.shift_start);
      const workMins = att ? liveWorkMinutes(att, now, shift.shift_start) : 0;
      const breakMins = att ? liveBreakMinutes(att, now) : 0;
      const penalty = lateCheckInPenalty(att?.check_in, shift.shift_start, !!att?.penalty_waived);
      const work_start = att?.check_in
        ? effectiveWorkStart(att.check_in, shift.shift_start, !!att.penalty_waived)
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
        late_minutes: penalty.late_minutes,
        penalty_minutes: penalty.penalty_minutes,
        late_penalty_rule_minutes: LATE_CHECKIN_PENALTY_MINUTES,
        shift: {
          shift_start: shift.shift_start,
          shift_end: shift.shift_end,
          working_hours_per_day: threshold,
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
      Object.assign(rec, recalculateAttendanceFields(rec, shift.working_hours_per_day, shift.shift_start, shift.shift_end));
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
      },
    });

    const shift = await getEffectiveShiftForEmployee(employeeId);
    const now = nowTime();
    const live_status = computeLiveStatus(rec.toObject(), shift.working_hours_per_day, now, shift.shift_start);
    const penalty = lateCheckInPenalty(rec.check_in, shift.shift_start, !!rec.penalty_waived);
    res.json({
      ...rec.toObject(),
      live_status,
      work_start: rec.check_in
        ? effectiveWorkStart(rec.check_in, shift.shift_start, !!rec.penalty_waived)
        : null,
      late_minutes: penalty.late_minutes,
      penalty_minutes: penalty.penalty_minutes,
      late_penalty_rule_minutes: LATE_CHECKIN_PENALTY_MINUTES,
      shift: {
        shift_start: shift.shift_start,
        shift_end: shift.shift_end,
        working_hours_per_day: shift.working_hours_per_day,
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
      Object.assign(rec, recalculateAttendanceFields(rec, shift.working_hours_per_day, shift.shift_start, shift.shift_end));
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
