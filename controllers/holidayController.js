import Holiday, { HOLIDAY_TYPES } from '../models/Holiday.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const year = req.query.year ? Number(req.query.year) : null;
    const type = req.query.type;

    const q = {};
    if (year) q.year = year;
    if (type) q.type = type;
    if (search) {
      q.$or = [
        { name: { $regex: search, $options: 'i' } },
        { date: { $regex: search, $options: 'i' } },
        { start_date: { $regex: search, $options: 'i' } },
        { end_date: { $regex: search, $options: 'i' } },
      ];
    }

    const items = await Holiday.find(q).lean();
    items.sort((a, b) => {
      const da = a.date || a.start_date || '';
      const db_ = b.date || b.start_date || '';
      return da < db_ ? 1 : da > db_ ? -1 : 0;
    });
    const total = items.length;
    const data = items.slice(skip, skip + limit);

    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function create(req, res) {
  try {
    const { type, name, date, start_date, end_date } = req.body;
    if (!HOLIDAY_TYPES.includes(type)) {
      return res.status(400).json({ message: `type must be one of: ${HOLIDAY_TYPES.join(', ')}` });
    }

    if (type === 'Vacation') {
      if (!name || !start_date || !end_date) {
        return res.status(400).json({ message: 'name, start_date, and end_date are required' });
      }
      const year = new Date(start_date + 'T00:00:00').getFullYear();
      const doc = await Holiday.create({
        type,
        name,
        start_date,
        end_date,
        year,
        date: null,
        month: null,
      });
      return res.status(201).json(doc);
    }

    if (!date) return res.status(400).json({ message: 'date is required' });
    if ((type === 'Festival' || type === 'Manual') && !name?.trim()) {
      return res.status(400).json({ message: 'name is required' });
    }

    const d = new Date(date + 'T00:00:00');
    const doc = await Holiday.create({
      type,
      name: type === 'Saturday' ? name || 'Alternate Saturday' : name.trim(),
      date,
      day: type === 'Saturday' ? '' : DAYS[d.getDay()],
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      start_date: null,
      end_date: null,
    });
    res.status(201).json(doc);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function remove(req, res) {
  try {
    const doc = await Holiday.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Holiday not found' });
    res.json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
