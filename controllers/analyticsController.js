import { buildYearAnalytics } from '../services/analytics.js';

export async function getAnalytics(req, res) {
  try {
    const now = new Date();
    const requested = Number(req.query.year);
    const year = Number.isFinite(requested) && requested >= 2026
      ? requested
      : Math.max(2026, now.getFullYear());
    if (year < 2026) {
      return res.status(400).json({ message: 'Year must be 2026 or later' });
    }

    let month;
    if (req.query.month != null && req.query.month !== '') {
      month = Number(req.query.month);
      if (!Number.isFinite(month) || month < 1 || month > 12) {
        return res.status(400).json({ message: 'Month must be between 1 and 12' });
      }
    }

    const data = await buildYearAnalytics({
      year,
      month,
      department_id: req.query.department_id || undefined,
      employee_id: req.query.employee_id || undefined,
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
