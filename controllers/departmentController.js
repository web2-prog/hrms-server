import Department from '../models/Department.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';

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
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function create(req, res) {
  try {
    const dept = await Department.create(req.body);
    res.status(201).json(dept);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function update(req, res) {
  try {
    const dept = await Department.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
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
