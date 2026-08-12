import Employee from '../models/Employee.js';

/** Restrict list filters so employees always see only their own records. */
export async function applyEmployeeListScope(req, filter = {}, { search } = {}) {
  if (req.user.role === 'employee') {
    filter.employee_id = req.user._id;
    return filter;
  }

  if (req.query.employee_id) filter.employee_id = req.query.employee_id;

  if (req.query.department_id) {
    const emps = await Employee.find({ department_id: req.query.department_id }).select('_id');
    filter.employee_id = { $in: emps.map((e) => e._id) };
  }

  if (search) {
    const emps = await Employee.find({
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { employee_id: { $regex: search, $options: 'i' } },
      ],
    }).select('_id');
    const ids = emps.map((e) => e._id);
    if (filter.employee_id) {
      const existing = filter.employee_id.$in ? filter.employee_id.$in : [filter.employee_id];
      filter.employee_id = {
        $in: existing.filter((id) => ids.some((eid) => String(eid) === String(id))),
      };
    } else {
      filter.employee_id = { $in: ids };
    }
  }

  return filter;
}
