import Policy from '../models/Policy.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};

    // Employees only see active policies
    if (req.user.role === 'employee') {
      filter.status = 'active';
    } else if (req.query.status) {
      filter.status = req.query.status;
    }

    if (req.query.category) filter.category = req.query.category;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { content: { $regex: search, $options: 'i' } },
      ];
    }

    const [data, total] = await Promise.all([
      Policy.find(filter)
        .populate('created_by', 'name')
        .populate('updated_by', 'name')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit),
      Policy.countDocuments(filter),
    ]);
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function getOne(req, res) {
  try {
    const policy = await Policy.findById(req.params.id)
      .populate('created_by', 'name')
      .populate('updated_by', 'name');
    if (!policy) return res.status(404).json({ message: 'Not found' });
    if (req.user.role === 'employee' && policy.status !== 'active') {
      return res.status(403).json({ message: 'Forbidden' });
    }
    res.json(policy);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function create(req, res) {
  try {
    const { title, content, category, status, effective_date } = req.body;
    if (!title?.trim() || !content?.trim()) {
      return res.status(400).json({ message: 'Title and content are required' });
    }
    const policy = await Policy.create({
      title: title.trim(),
      content: content.trim(),
      category: category || 'General',
      status: status || 'active',
      effective_date: effective_date || null,
      created_by: req.user._id,
      updated_by: req.user._id,
    });
    res.status(201).json(policy);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function update(req, res) {
  try {
    const { title, content, category, status, effective_date } = req.body;
    const updates = { updated_by: req.user._id };
    if (title !== undefined) updates.title = String(title).trim();
    if (content !== undefined) updates.content = String(content).trim();
    if (category !== undefined) updates.category = category;
    if (status !== undefined) updates.status = status;
    if (effective_date !== undefined) updates.effective_date = effective_date || null;

    if (updates.title === '' || updates.content === '') {
      return res.status(400).json({ message: 'Title and content cannot be empty' });
    }

    const policy = await Policy.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    })
      .populate('created_by', 'name')
      .populate('updated_by', 'name');
    if (!policy) return res.status(404).json({ message: 'Not found' });
    res.json(policy);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function remove(req, res) {
  try {
    const policy = await Policy.findByIdAndDelete(req.params.id);
    if (!policy) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
