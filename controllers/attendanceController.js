import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
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
    const shift = await getEffectiveShiftForEmployee(req.user._id);
    const month = new Date().getMonth() + 1;
    const year = new Date().getFullYear();
    const summary = await recalculateMonthlySummary(req.user._id, month, year);
    res.json({ attendance: rec, shift, monthly_summary: summary });
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
    res.json(rec);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};
    if (req.query.employee_id) filter.employee_id = req.query.employee_id;
    if (req.query.status) filter.status = req.query.status;
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
