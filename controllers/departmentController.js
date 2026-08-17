import Department from '../models/Department.js';
import Employee from '../models/Employee.js';
import { buildDepartmentAnalytics } from '../services/analytics.js';
import { parseListQuery, listResponse, normalizeLateBufferMinutes } from '../utils/helpers.js';

function normalizeDeptBody(body = {}) {
  const next = { ...body };
  if (next.late_buffer_minutes !== undefined) {
    next.late_buffer_minutes = normalizeLateBufferMinutes(next.late_buffer_minutes);
  }
  return next;
}

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (search) filter.name = { $regex: search, $options: 'i' };
    const [data, total] = await Promise.all([
      Department.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
      Department.countDocuments(filter),
    ]);

    // Attach per-department headcounts (all members + active members).
    const ids = data.map((d) => d._id);
    let counts = new Map();
    if (ids.length) {
      const rows = await Employee.aggregate([
        { $match: { department_id: { $in: ids } } },
        {
          $group: {
            _id: '$department_id',
            members: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          },
        },
      ]);
      counts = new Map(rows.map((r) => [String(r._id), r]));
    }

    const payload = data.map((d) => {
      const c = counts.get(String(d._id)) || { members: 0, active: 0 };
      return {
        ...d.toJSON(),
        members: c.members,
        active_members: c.active,
      };
    });
    res.json(listResponse(payload, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function create(req, res) {
  try {
    const dept = await Department.create(normalizeDeptBody(req.body));
    res.status(201).json(dept);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function update(req, res) {
  try {
    const dept = await Department.findByIdAndUpdate(req.params.id, normalizeDeptBody(req.body), {
      new: true,
      runValidators: true,
    });
    if (!dept) return res.status(404).json({ message: 'Not found' });
    res.json(dept);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function remove(req, res) {
  try {
    const dept = await Department.findByIdAndDelete(req.params.id);
    if (!dept) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function getOne(req, res) {
  const dept = await Department.findById(req.params.id);
  if (!dept) return res.status(404).json({ message: 'Not found' });
  res.json(dept);
}

export async function analytics(req, res) {
  try {
    const now = new Date();
    const requested = Number(req.query.year);
    const year = Number.isFinite(requested) && requested >= 2026
      ? requested
      : Math.max(2026, now.getFullYear());
    const data = await buildDepartmentAnalytics({ year });
    res.json(data);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
