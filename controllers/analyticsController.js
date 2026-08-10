import { buildYearAnalytics } from '../services/analytics.js';

export async function getAnalytics(req, res) {
  try {
    const now = new Date();
    const year = Number(req.query.year) || Math.max(2026, now.getFullYear());
    if (year < 2026) {
      return res.status(400).json({ message: 'Year must be 2026 or later' });
    }

    const data = await buildYearAnalytics({
      year,
      department_id: req.query.department_id || undefined,
      employee_id: req.query.employee_id || undefined,
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
