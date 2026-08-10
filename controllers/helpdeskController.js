import HelpdeskTicket, { TICKET_TYPES, TICKET_STATUSES, TICKET_PRIORITIES } from '../models/HelpdeskTicket.js';
import Employee from '../models/Employee.js';
import { parseListQuery, listResponse } from '../utils/helpers.js';

export async function list(req, res) {
  try {
    const { page, limit, skip, search } = parseListQuery(req.query);
    const filter = {};

    if (req.user.role === 'employee') {
      filter.employee_id = req.user._id;
    } else if (req.query.employee_id) {
      filter.employee_id = req.query.employee_id;
    }

    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.priority) filter.priority = req.query.priority;

    if (req.query.department_id && req.user.role !== 'employee') {
      const emps = await Employee.find({ department_id: req.query.department_id }).select('_id');
      filter.employee_id = { $in: emps.map((e) => e._id) };
    }

    if (search) {
      const nameFilter = {
        $or: [{ name: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }],
      };
      const emps = await Employee.find(nameFilter).select('_id');
      filter.$or = [
        { subject: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { employee_id: { $in: emps.map((e) => e._id) } },
      ];
    }

    const [data, total] = await Promise.all([
      HelpdeskTicket.find(filter)
        .populate({ path: 'employee_id', populate: { path: 'department_id' } })
        .populate('handled_by', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      HelpdeskTicket.countDocuments(filter),
    ]);
    res.json(listResponse(data, total, page, limit));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function getOne(req, res) {
  try {
    const ticket = await HelpdeskTicket.findById(req.params.id)
      .populate({ path: 'employee_id', populate: { path: 'department_id' } })
      .populate('handled_by', 'name');
    if (!ticket) return res.status(404).json({ message: 'Not found' });
    if (req.user.role === 'employee' && String(ticket.employee_id?._id || ticket.employee_id) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    res.json(ticket);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function create(req, res) {
  try {
    const { type, subject, description, priority } = req.body;
    if (!TICKET_TYPES.includes(type)) {
      return res.status(400).json({ message: 'Type must be Complaint or HR Request' });
    }
    if (!subject?.trim() || !description?.trim()) {
      return res.status(400).json({ message: 'Subject and description are required' });
    }
    const resolvedPriority = TICKET_PRIORITIES.includes(priority) ? priority : 'Medium';
    const ticket = await HelpdeskTicket.create({
      employee_id: req.user._id,
      type,
      subject: subject.trim(),
      description: description.trim(),
      priority: resolvedPriority,
      status: 'Pending',
    });
    const populated = await HelpdeskTicket.findById(ticket._id).populate({
      path: 'employee_id',
      populate: { path: 'department_id' },
    });
    res.status(201).json(populated);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

export async function respond(req, res) {
  try {
    const { status, admin_response } = req.body;
    if (!TICKET_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const ticket = await HelpdeskTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Not found' });

    ticket.status = status;
    if (admin_response !== undefined) ticket.admin_response = String(admin_response).trim();
    ticket.handled_by = req.user._id;
    ticket.handled_on = new Date();
    await ticket.save();

    const populated = await HelpdeskTicket.findById(ticket._id)
      .populate({ path: 'employee_id', populate: { path: 'department_id' } })
      .populate('handled_by', 'name');
    res.json(populated);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function remove(req, res) {
  try {
    const ticket = await HelpdeskTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Not found' });
    if (req.user.role === 'employee') {
      if (String(ticket.employee_id) !== String(req.user._id)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      if (ticket.status !== 'Pending') {
        return res.status(400).json({ message: 'Only pending tickets can be withdrawn' });
      }
    }
    await ticket.deleteOne();
    res.json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
