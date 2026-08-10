import AuditLog from '../models/AuditLog.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';
import { getWorkingDaysOfYear } from '../services/workingDays.js';
import { getSettings } from '../services/salaryCalc.js';
import SystemSettings from '../models/SystemSettings.js';
import MonthlySummary from '../models/MonthlySummary.js';
import { recalculateMonthlySummary } from '../services/monthlyHours.js';

export async function listAudit(req, res) {
  try {
    const { page, limit, skip } = parseListQuery(req.query);
    const [data, total] = await Promise.all([
      AuditLog.find()
        .populate('performed_by', 'name email')
        .populate('target_employee_id', 'name employee_id')
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit),
      AuditLog.countDocuments(),
    ]);
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function workingDays(req, res) {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const result = await getWorkingDaysOfYear(year);
    res.json(result);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function getSystemSettings(req, res) {
  const s = await getSettings();
  res.json(s);
}

export async function updateSystemSettings(req, res) {
  const s = await SystemSettings.findOneAndUpdate(
    { key: 'global' },
    {
      overtime_multiplier: req.body.overtime_multiplier,
      deduction_multiplier: req.body.deduction_multiplier,
    },
    { upsert: true, new: true }
  );
  res.json(s);
}

export async function getMonthlySummary(req, res) {
  try {
    const { employee_id, month, year } = req.query;
    const eid = employee_id || req.user._id;
    if (req.user.role === 'employee' && String(eid) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const doc = await recalculateMonthlySummary(eid, Number(month), Number(year));
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
