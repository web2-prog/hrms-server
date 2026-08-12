import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import EarlyCheckoutRequest from '../models/EarlyCheckoutRequest.js';
import {
  parseListQuery,
  listResponse,
  todayISO,
  nowTime,
  minutesBetween,
  normalizeTime,
  parseBreakMinutes,
} from '../utils/helpers.js';
import { getEffectiveShiftForEmployee } from '../services/shift.js';
import { recalculateAttendanceFields } from '../services/attendanceCalc.js';
import { recalculateForDate, recalculateMonthlySummary } from '../services/monthlyHours.js';
import AuditLog from '../models/AuditLog.js';

async function getOrCreateToday(employeeId) {
  const date = todayISO();
  let rec = await Attendance.findOne({ employee_id: employeeId, date });
  if (!rec) rec = await Attendance.create({ employee_id: employeeId, date, status: 'Absent' });
  return rec;
}

export async function myToday(req, res) {
  try {
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
    res.json({ attendance: rec, shift, monthly_summary: summary, early_checkout_request });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function checkIn(req, res) {
  try {
    const rec = await getOrCreateToday(req.user._id);
    if (rec.check_in) return res.status(400).json({ message: 'Already checked in' });
    rec.check_in = nowTime();
    rec.status = 'Working';
    await rec.save();
    res.json(rec);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function startBreak(req, res) {
  try {
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
    const rec = await getOrCreateToday(req.user._id);
    if (!rec.check_in) return res.status(400).json({ message: 'Not checked in' });
    if (rec.check_out) return res.status(400).json({ message: 'Already checked out' });
    if (rec.break_started_at) {
      const mins = minutesBetween(rec.break_started_at, nowTime());
      rec.break_total = Number(((rec.break_total || 0) + Math.max(0, mins)).toFixed(4));
      rec.break_started_at = null;
    }
    rec.check_out = nowTime();
    const shift = await getEffectiveShiftForEmployee(req.user._id);
    const fields = recalculateAttendanceFields(rec, shift.working_hours_per_day);
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
        Object.assign(rec, recalculateAttendanceFields(rec, shift.working_hours_per_day));
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
    if (req.query.employee_id) filter.employee_id = req.query.employee_id;
    if (req.query.status === 'OnBreak') {
      // Include stale Working rows that still have an open break
      filter.$or = [
        { status: 'OnBreak' },
        { break_started_at: { $nin: [null, ''] } },
      ];
      filter.check_out = null;
    } else if (req.query.status === 'Working') {
      filter.status = 'Working';
      filter.$and = [
        { $or: [{ break_started_at: null }, { break_started_at: '' }, { break_started_at: { $exists: false } }] },
      ];
    } else if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.month && req.query.year) {
      const m = String(req.query.month).padStart(2, '0');
      filter.date = { $regex: `^${req.query.year}-${m}` };
    } else if (req.query.year) {
      filter.date = { $regex: `^${req.query.year}` };
    }
    if (req.query.department_id) {
      const emps = await Employee.find({ department_id: req.query.department_id }).select('_id');
      filter.employee_id = { $in: emps.map((e) => e._id) };
    }
    if (req.user.role === 'employee') filter.employee_id = req.user._id;

    let employeeIds = null;
    if (search) {
      const emps = await Employee.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { employee_id: { $regex: search, $options: 'i' } },
        ],
      }).select('_id');
      employeeIds = emps.map((e) => e._id);
      filter.employee_id = filter.employee_id
        ? { $in: [].concat(filter.employee_id.$in || filter.employee_id).filter((id) => employeeIds.some((e) => String(e) === String(id))) }
        : { $in: employeeIds };
    }

    const [raw, total] = await Promise.all([
      Attendance.find(filter).populate({ path: 'employee_id', populate: { path: 'department_id' } }).sort({ date: -1 }).skip(skip).limit(limit),
      Attendance.countDocuments(filter),
    ]);
    // Ensure live break shows as OnBreak even if status field is stale
    const data = raw.map((doc) => {
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
    const { check_in, check_out, break_total } = req.body;
    if (check_in !== undefined) rec.check_in = normalizeTime(check_in);
    if (check_out !== undefined) rec.check_out = normalizeTime(check_out);
    if (break_total !== undefined) rec.break_total = Number(parseBreakMinutes(break_total).toFixed(4));
    const shift = await getEffectiveShiftForEmployee(rec.employee_id);
    const fields = recalculateAttendanceFields(rec, shift.working_hours_per_day);
    Object.assign(rec, fields);
    await rec.save();
    await recalculateForDate(rec.employee_id, rec.date);
    res.json(rec);
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
      if (u.check_out !== undefined) rec.check_out = normalizeTime(u.check_out);
      if (u.break_total !== undefined) rec.break_total = Number(parseBreakMinutes(u.break_total).toFixed(4));
      const shift = await getEffectiveShiftForEmployee(rec.employee_id);
      Object.assign(rec, recalculateAttendanceFields(rec, shift.working_hours_per_day));
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
