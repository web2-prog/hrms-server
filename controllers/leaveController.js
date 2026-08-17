import Leave from '../models/Leave.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';
import { applyEmployeeListScope } from '../utils/employeeScope.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';
import { datesInRange } from '../utils/helpers.js';

function isValidIsoDate(value) {
  const s = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.day_type === 'Full Day') {
      filter.$or = [{ day_type: 'Full Day' }, { day_type: { $exists: false } }, { day_type: null }];
    } else if (req.query.day_type) {
      filter.day_type = req.query.day_type;
    }
    if (req.query.month && req.query.year) {
      const m = Math.max(1, Math.min(12, parseInt(req.query.month, 10) || 1));
      const y = parseInt(req.query.year, 10);
      const mm = String(m).padStart(2, '0');
      const start = `${y}-${mm}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const end = `${y}-${mm}-${String(lastDay).padStart(2, '0')}`;
      filter.from_date = { $lte: end };
      filter.to_date = { $gte: start };
    } else if (req.query.year) {
      const y = parseInt(req.query.year, 10);
      filter.from_date = { $lte: `${y}-12-31` };
      filter.to_date = { $gte: `${y}-01-01` };
    } else if (req.query.from_date && req.query.to_date) {
      filter.from_date = { $lte: req.query.to_date };
      filter.to_date = { $gte: req.query.from_date };
    }

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const when = String(req.query.when || '').toLowerCase();
    const whenClauses = [];
    if (when === 'upcoming') {
      // Leaves not yet finished (today + future)
      whenClauses.push({ to_date: { $gte: todayStr } });
    } else if (when === 'future') {
      // Leaves that start after today
      whenClauses.push({ from_date: { $gt: todayStr } });
    } else if (when === 'past') {
      whenClauses.push({ to_date: { $lt: todayStr } });
    }
    if (whenClauses.length) {
      filter.$and = [...(filter.$and || []), ...whenClauses];
    }

    await applyEmployeeListScope(req, filter, { search });

    const sort =
      when === 'upcoming' || when === 'future'
        ? { from_date: 1, applied_on: -1 }
        : { applied_on: -1 };

    const [data, total] = await Promise.all([
      Leave.find(filter)
        .populate({ path: 'employee_id', populate: { path: 'department_id' } })
        .populate('approved_by', 'name')
        .sort(sort)
        .skip(skip)
        .limit(limit),
      Leave.countDocuments(filter),
    ]);
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function apply(req, res) {
  try {
    const { from_date, to_date, reason, day_type } = req.body;
    if (!from_date || !to_date) return res.status(400).json({ message: 'Dates required' });
    if (!isValidIsoDate(from_date) || !isValidIsoDate(to_date)) {
      return res.status(400).json({ message: 'Use valid dates in YYYY-MM-DD format' });
    }
    if (from_date > to_date) return res.status(400).json({ message: 'End date cannot be before start date' });
    const resolvedDayType = day_type === 'Half Day' ? 'Half Day' : 'Full Day';
    if (resolvedDayType === 'Half Day' && from_date !== to_date) {
      return res.status(400).json({ message: 'Half Day leave must be for a single date' });
    }
    const leave = await Leave.create({
      employee_id: req.user._id,
      from_date,
      to_date: resolvedDayType === 'Half Day' ? from_date : to_date,
      day_type: resolvedDayType,
      reason: reason || '',
      status: 'Pending',
    });
    res.status(201).json(leave);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function decide(req, res) {
  try {
    const { status } = req.body;
    if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ message: 'Not found' });
    const previousStatus = leave.status;
    leave.status = status;
    leave.approved_by = req.user._id;
    leave.approved_on = new Date();
    await leave.save();

    // Any approval-state change affects the monthly target, including
    // Approved → Rejected reversals.
    if (previousStatus !== status && (previousStatus === 'Approved' || status === 'Approved')) {
      const months = new Set();
      for (const d of datesInRange(leave.from_date, leave.to_date)) {
        months.add(`${d.slice(0, 4)}-${d.slice(5, 7)}`);
      }
      for (const key of months) {
        const [y, m] = key.split('-').map(Number);
        await recalculateMonthlySummary(leave.employee_id, m, y);
      }
    }
    res.json(leave);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
