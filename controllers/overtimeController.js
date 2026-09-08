import OvertimeRequest from '../models/OvertimeRequest.js';
import Attendance from '../models/Attendance.js';
import { parseListQuery, listResponse, todayISO, hoursToMinutes } from '../utils/helpers.js';
import { applyEmployeeListScope } from '../utils/employeeScope.js';
import { assertCanDecideRequest } from '../utils/staffPermissions.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';
import { computeSurplusSplit } from '../services/surplusSplit.js';

function monthDateFilter(month, year) {
  if (!month || !year) return null;
  const m = Math.max(1, Math.min(12, parseInt(month, 10) || 1));
  const y = parseInt(year, 10);
  const mm = String(m).padStart(2, '0');
  return { $regex: `^${y}-${mm}` };
}

function mapRequestRow(doc) {
  const json = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
  const hours = Number(json.hours) || 0;
  const minutes = json.minutes != null ? Number(json.minutes) : hoursToMinutes(hours);
  return {
    ...json,
    source: 'request',
    hours,
    minutes,
  };
}

function mapAttendanceRow(doc) {
  const json = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
  const hours = Math.max(0, Number(json.surplus_shortfall) || 0);
  const rounded = Math.round(hours * 10000) / 10000;
  return {
    _id: `att_${json._id}`,
    attendance_id: json._id,
    source: 'attendance',
    employee_id: json.employee_id,
    date: json.date,
    hours: rounded,
    minutes: hoursToMinutes(rounded),
    reason: 'Auto (worked beyond daily hours)',
    status: 'Extra',
    ot_type: 'General',
    working_hours: json.working_hours,
    working_minutes: hoursToMinutes(json.working_hours),
    applied_on: json.updatedAt || json.createdAt,
  };
}

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const source = String(req.query.source || 'all').toLowerCase(); // all | requests | attendance
    const dateRegex = monthDateFilter(req.query.month, req.query.year);

    const empFilter = {};
    await applyEmployeeListScope(req, empFilter, { search });

    const includeRequests = source === 'all' || source === 'requests' || source === 'request';
    const includeAttendance =
      (source === 'all' || source === 'attendance') &&
      (!req.query.status || req.query.status === 'Extra') &&
      (!req.query.ot_type || req.query.ot_type === 'General' || req.query.ot_type === 'Attendance');

    const includeRequestsFiltered =
      includeRequests &&
      req.query.ot_type !== 'Attendance' &&
      req.query.ot_type !== 'General' &&
      req.query.status !== 'Extra';

    let rows = [];

    if (includeRequestsFiltered) {
      const filter = { ...empFilter };
      if (req.query.status) filter.status = req.query.status;
      if (req.query.ot_type && req.query.ot_type !== 'Attendance' && req.query.ot_type !== 'General') {
        filter.ot_type = req.query.ot_type;
      } else if (req.query.ot_type === 'General') {
        filter.ot_type = 'Management';
      }
      if (dateRegex) filter.date = dateRegex;
      else if (req.query.from_date && req.query.to_date) {
        filter.date = { $gte: req.query.from_date, $lte: req.query.to_date };
      }

      const reqs = await OvertimeRequest.find(filter)
        .populate({ path: 'employee_id', populate: { path: 'department_id', select: 'name' } })
        .populate('decided_by', 'name')
        .sort({ date: -1, applied_on: -1 })
        .lean();
      rows.push(...reqs.map(mapRequestRow));
    }

    if (includeAttendance) {
      const filter = {
        ...empFilter,
        status: 'Extra',
        auto_checkout: { $ne: true },
        surplus_shortfall: { $gt: 0 },
      };
      if (dateRegex) filter.date = dateRegex;
      else if (req.query.from_date && req.query.to_date) {
        filter.date = { $gte: req.query.from_date, $lte: req.query.to_date };
      }

      const atts = await Attendance.find(filter)
        .populate({ path: 'employee_id', populate: { path: 'department_id', select: 'name' } })
        .sort({ date: -1 })
        .lean();
      rows.push(...atts.map(mapAttendanceRow));
    }

    rows.sort((a, b) => {
      const d = String(b.date || '').localeCompare(String(a.date || ''));
      if (d !== 0) return d;
      return String(b.applied_on || '').localeCompare(String(a.applied_on || ''));
    });

    const total = rows.length;
    const data = rows.slice(skip, skip + limit);
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

/** Preview: Management OT = remaining surplus after Cover Time allocation. */
export async function eligibleHours(req, res) {
  try {
    const date = String(req.query.date || todayISO());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'Use a valid date in YYYY-MM-DD format' });
    }
    if (date > todayISO()) {
      return res.status(400).json({ message: 'Cannot request Management OT for a future date' });
    }
    const split = await computeSurplusSplit(req.user._id, date);
    res.json({
      date: split.date,
      hours: split.management_ot_hours,
      minutes: split.management_ot_minutes ?? hoursToMinutes(split.management_ot_hours),
      eligible: !!split.management_ot_eligible,
      message: split.management_ot_eligible ? null : split.management_ot_message,
      work_hours: split.work_hours,
      work_minutes: split.work_minutes,
      full_hours: split.full_hours,
      full_minutes: split.full_minutes,
      checked_out: !!split.checked_out,
      daily_surplus: split.daily_surplus,
      daily_surplus_minutes: split.daily_surplus_minutes,
      cover_hours: split.cover_hours,
      cover_minutes: split.cover_minutes,
      management_ot_hours: split.management_ot_hours,
      management_ot_minutes: split.management_ot_minutes,
      monthly_shortfall: split.monthly_shortfall,
      monthly_shortfall_minutes: split.monthly_shortfall_minutes,
      cover_eligible: split.cover_eligible,
      min_cover_hours: split.min_cover_hours,
      min_cover_minutes: split.min_cover_minutes,
      claimed_cover_hours: split.claimed_cover_hours,
      claimed_cover_minutes: hoursToMinutes(split.claimed_cover_hours),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function apply(req, res) {
  try {
    const { reason } = req.body;
    const date = String(req.body.date || todayISO());
    if (!date) return res.status(400).json({ message: 'Date required' });
    const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return res.status(400).json({ message: 'Use a valid date in YYYY-MM-DD format' });
    const [, yy, mm, dd] = match;
    const parsed = new Date(Date.UTC(Number(yy), Number(mm) - 1, Number(dd)));
    if (
      parsed.getUTCFullYear() !== Number(yy) ||
      parsed.getUTCMonth() !== Number(mm) - 1 ||
      parsed.getUTCDate() !== Number(dd)
    ) {
      return res.status(400).json({ message: 'Use a valid calendar date' });
    }
    if (!reason || !String(reason).trim()) return res.status(400).json({ message: 'Reason required' });

    const year = Number(yy);
    if (year < 2026) return res.status(400).json({ message: 'Year must be 2026 or later' });
    if (date > todayISO()) {
      return res.status(400).json({ message: 'Cannot request Management OT for a future date' });
    }

    if (req.body.ot_type && req.body.ot_type !== 'Management') {
      return res.status(400).json({
        message: 'General OT is automatic when you work beyond daily hours. Only Management OT can be requested.',
      });
    }

    // Hours = worked (through checkout / live now) − daily working hours − Cover Time.
    // Never accept hours from the client body.
    const split = await computeSurplusSplit(req.user._id, date);
    if (!split.management_ot_eligible) {
      return res.status(400).json({
        message: split.management_ot_message || 'Management OT is not available',
      });
    }
    if (!(split.management_ot_hours > 0)) {
      return res.status(400).json({
        message: 'No Management OT hours from daily working hours through checkout',
      });
    }

    const hours = split.management_ot_hours;
    const minutes = hoursToMinutes(hours);
    const doc = await OvertimeRequest.create({
      employee_id: req.user._id,
      date,
      hours,
      minutes,
      reason: String(reason).trim(),
      status: 'Pending',
      ot_type: 'Management',
    });
    res.status(201).json(doc);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function decide(req, res) {
  try {
    const { status, decision_note } = req.body;
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const doc = await OvertimeRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Not found' });
    if (doc.status !== 'Pending') {
      return res.status(400).json({ message: 'Request already decided' });
    }
    const gate = await assertCanDecideRequest(req.user, doc.employee_id);
    if (gate.error) return res.status(gate.status).json({ message: gate.error });

    if (status === 'Approved') {
      doc.ot_type = 'Management';
    } else {
      doc.ot_type = undefined;
    }

    doc.status = status;
    doc.decided_by = req.user._id;
    doc.decided_on = new Date();
    doc.decision_note = decision_note || '';
    await doc.save();

    const [y, m] = doc.date.split('-').map(Number);
    await recalculateMonthlySummary(doc.employee_id, m, y);

    const populated = await OvertimeRequest.findById(doc._id)
      .populate({ path: 'employee_id', populate: { path: 'department_id', select: 'name' } })
      .populate('decided_by', 'name');
    res.json(populated);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
