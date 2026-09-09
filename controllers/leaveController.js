import Leave from '../models/Leave.js';
import Employee from '../models/Employee.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';
import { applyEmployeeListScope } from '../utils/employeeScope.js';
import { assertCanDecideRequest, assertCanActOnStaffRecord, isElevatedRole } from '../utils/staffPermissions.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';
import { datesInRange } from '../utils/helpers.js';

async function recalculateLeaveMonths(employeeId, fromDate, toDate) {
  const months = new Set();
  for (const d of datesInRange(fromDate, toDate)) {
    months.add(`${d.slice(0, 4)}-${d.slice(5, 7)}`);
  }
  for (const key of months) {
    const [y, m] = key.split('-').map(Number);
    await recalculateMonthlySummary(employeeId, m, y);
  }
}

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};
    if (req.query.status) {
      const statuses = String(req.query.status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length === 1) filter.status = statuses[0];
      else if (statuses.length > 1) filter.status = { $in: statuses };
    }
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
    } else if (req.query.month) {
      const m = Math.max(1, Math.min(12, parseInt(req.query.month, 10) || 1));
      // Overlaps calendar month `m` in any year (same-year span, or a wrap that includes `m`).
      filter.$expr = {
        $let: {
          vars: {
            f: { $dateFromString: { dateString: '$from_date' } },
            t: { $dateFromString: { dateString: '$to_date' } },
          },
          in: {
            $let: {
              vars: {
                yf: { $year: '$$f' },
                yt: { $year: '$$t' },
                mf: { $month: '$$f' },
                mt: { $month: '$$t' },
              },
              in: {
                $cond: [
                  { $eq: ['$$yf', '$$yt'] },
                  { $and: [{ $lte: ['$$mf', m] }, { $gte: ['$$mt', m] }] },
                  {
                    $or: [
                      { $gt: [{ $subtract: ['$$yt', '$$yf'] }, 1] },
                      { $gte: ['$$mf', m] },
                      { $lte: ['$$mt', m] },
                    ],
                  },
                ],
              },
            },
          },
        },
      };
    } else if (req.query.from_date && req.query.to_date) {
      filter.from_date = { $lte: req.query.to_date };
      filter.to_date = { $gte: req.query.from_date };
    }

    // Decision window (approved_on) — used by HR "recent requests" modal (last N days).
    if (req.query.decided_from || req.query.decided_to) {
      filter.approved_on = {};
      if (req.query.decided_from) {
        filter.approved_on.$gte = new Date(`${req.query.decided_from}T00:00:00.000+05:30`);
      }
      if (req.query.decided_to) {
        filter.approved_on.$lte = new Date(`${req.query.decided_to}T23:59:59.999+05:30`);
      }
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
    // Upcoming/future = active leave plan. Rejected must not appear there
    // unless the caller explicitly filters status=Rejected.
    if ((when === 'upcoming' || when === 'future') && !req.query.status) {
      whenClauses.push({ status: { $ne: 'Rejected' } });
    }
    if (whenClauses.length) {
      filter.$and = [...(filter.$and || []), ...whenClauses];
    }

    await applyEmployeeListScope(req, filter, { search });

    const sort =
      when === 'upcoming' || when === 'future'
        ? { from_date: 1, applied_on: -1 }
        : req.query.decided_from || req.query.decided_to
          ? { approved_on: -1, applied_on: -1 }
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
    const { from_date, to_date, reason, day_type, employee_id, status: bodyStatus } = req.body;
    if (!from_date || !to_date) return res.status(400).json({ message: 'Dates required' });
    const resolvedDayType = day_type === 'Half Day' ? 'Half Day' : 'Full Day';
    if (resolvedDayType === 'Half Day' && from_date !== to_date) {
      return res.status(400).json({ message: 'Half Day leave must be for a single date' });
    }

    const to = resolvedDayType === 'Half Day' ? from_date : to_date;
    const isStaff = isElevatedRole(req.user.role);
    const wantsOtherEmployee = !!(employee_id && String(employee_id) !== String(req.user._id));

    let targetId = req.user._id;
    let status = 'Pending';
    let approved_by = null;
    let approved_on = null;

    // HR/Admin can add a manual leave for another employee (default Approved).
    if (isStaff && wantsOtherEmployee) {
      const gate = await assertCanActOnStaffRecord(req.user, employee_id, 'add leave for');
      if (gate.error) return res.status(gate.status).json({ message: gate.error });
      const emp = await Employee.findById(employee_id).select('_id status').lean();
      if (!emp) return res.status(404).json({ message: 'Employee not found' });
      targetId = emp._id;
      // Manual leave defaults to Approved; pass status=Pending to queue for decision.
      status = bodyStatus === 'Pending' ? 'Pending' : 'Approved';
      if (status === 'Approved') {
        approved_by = req.user._id;
        approved_on = new Date();
      }
    } else if (!isStaff && employee_id && String(employee_id) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Employees can only apply leave for themselves' });
    }

    const leave = await Leave.create({
      employee_id: targetId,
      from_date,
      to_date: to,
      day_type: resolvedDayType,
      reason: reason || '',
      status,
      approved_by,
      approved_on,
    });

    if (status === 'Approved') {
      await recalculateLeaveMonths(targetId, from_date, to);
    }

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
    const gate = await assertCanDecideRequest(req.user, leave.employee_id);
    if (gate.error) return res.status(gate.status).json({ message: gate.error });
    leave.status = status;
    leave.approved_by = req.user._id;
    leave.approved_on = new Date();
    await leave.save();

    if (status === 'Approved') {
      await recalculateLeaveMonths(leave.employee_id, leave.from_date, leave.to_date);
    }
    res.json(leave);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
